// ============================================================================
// redeem-claim.js — bartender applies a redemption (and optionally pushes the
//                   discount onto a live Toast check)
//
// POST { adminPassword, code,
//        orderGuid?, checkGuid?,    // Toast: which open check to discount
//        openAmount?                // override $ for OPEN_* discount types
//      }
//
// Behavior:
//   1. Looks up the member with this pendingRedemption (already deducted at
//      redeem-init).
//   2. If orderGuid + checkGuid + a Toast discount GUID are all available,
//      calls Toast's appliedDiscounts endpoint to put the discount on the
//      check directly. Logs the result either way.
//   3. Logs to member history, clears pendingRedemption, returns details.
//
// Auth: same admin password as the admin portal (legacy plaintext fallback
// for now — same behavior as verify-admin-password while ADMIN_PASSWORD_HASH
// is unset).
// ============================================================================
const crypto = require('crypto');
const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

const TOAST_CLIENT_ID = process.env.TOAST_CLIENT_ID || '';
const TOAST_SECRET = process.env.TOAST_CLIENT_SECRET || '';
const TOAST_REST_GUID = process.env.TOAST_RESTAURANT_GUID || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

function checkAdmin(password) {
  if (!password) return false;
  if (ADMIN_PASSWORD_HASH) return sha256(password) === ADMIN_PASSWORD_HASH;
  return password === 'quarry2026'; // legacy fallback
}

function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: path,
      method: method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Redeem',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}') }); }
        catch (_) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}'), raw: d }); }
        catch (_) { resolve({ status: res.statusCode, data: d, raw: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getToastToken() {
  const r = await httpsRequest({
    hostname: 'ws-api.toasttab.com',
    path: '/authentication/v1/authentication/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    clientId: TOAST_CLIENT_ID, clientSecret: TOAST_SECRET,
    userAccessType: 'TOAST_MACHINE_CLIENT',
  });
  if (r.status !== 200 || !r.data.token) throw new Error('Toast auth: HTTP ' + r.status);
  return r.data.token.accessToken;
}

// Apply a discount to an open Toast check.
// rewardEntry = the toast-discount-map.json entry { guid, type, fixedAmount, percent, ... }
// openAmount  = bartender-entered $ for OPEN_* types (e.g. price of glass of wine)
async function applyDiscountToCheck(token, orderGuid, checkGuid, rewardEntry, openAmount) {
  if (!rewardEntry || !rewardEntry.guid) {
    return { applied: false, reason: 'no-discount-guid' };
  }
  const payload = {
    name: rewardEntry.label || 'Quarry Reward',
    discount: { guid: rewardEntry.guid },
    processingState: 'PENDING_APPROVAL',
  };
  if (rewardEntry.type === 'OPEN_ITEM' || rewardEntry.type === 'OPEN_CHECK') {
    if (openAmount && openAmount > 0) {
      payload.discountAmount = Number(openAmount);
    }
  } else if (rewardEntry.type === 'FIXED' || rewardEntry.type === 'FIXED_ITEM') {
    if (rewardEntry.fixedAmount) payload.discountAmount = Number(rewardEntry.fixedAmount);
  }
  // For percent discounts Toast computes the amount itself; payload just needs the guid.

  const path = '/orders/v2/orders/' + orderGuid + '/checks/' + checkGuid + '/appliedDiscounts';
  const r = await httpsRequest({
    hostname: 'ws-api.toasttab.com',
    path: path,
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Toast-Restaurant-External-ID': TOAST_REST_GUID,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  }, payload);
  return {
    applied: r.status >= 200 && r.status < 300,
    status: r.status,
    response: r.data,
  };
}

async function loadDiscountMap() {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/toast-discount-map.json');
  if (r.status !== 200) return null;
  try {
    return JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return reply(405, { ok: false, error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin(body.adminPassword)) {
    return reply(401, { ok: false, error: 'Invalid admin password' });
  }

  const code = (body.code || '').toUpperCase().trim();
  if (code.length !== 6) return reply(400, { ok: false, error: 'Enter the 6-character code' });

  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
  if (r.status !== 200) return reply(500, { ok: false, error: 'Could not load members' });
  const json = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  const sha = r.data.sha;

  const memberIdx = (json.members || []).findIndex((m) => m.pendingRedemption && m.pendingRedemption.code === code);
  if (memberIdx < 0) return reply(404, { ok: false, error: 'Code not found or already used' });

  const member = json.members[memberIdx];
  const pr = member.pendingRedemption;

  if (new Date(pr.expiresAt).getTime() < Date.now()) {
    delete member.pendingRedemption; // clean up expired
    json.lastUpdated = new Date().toISOString().split('T')[0];
    const cleanContent = Buffer.from(JSON.stringify(json, null, 2)).toString('base64');
    await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
      message: 'redeem-claim: clean up expired code ' + code,
      content: cleanContent,
      sha: sha,
    });
    return reply(410, { ok: false, error: 'Code expired. Member needs to generate a new one.' });
  }

  // -- Try to attach discount to a live Toast check, if one was selected. -----
  let toastResult = { applied: false, reason: 'no-check-selected' };
  if (body.orderGuid && body.checkGuid && TOAST_CLIENT_ID && TOAST_SECRET && TOAST_REST_GUID) {
    try {
      const map = await loadDiscountMap();
      const entry = map && map.rewards && map.rewards[pr.rewardId];
      if (!entry || !entry.applyToToast) {
        toastResult = { applied: false, reason: 'reward-not-mapped-or-offline', rewardId: pr.rewardId };
      } else if (!entry.guid) {
        toastResult = { applied: false, reason: 'discount-guid-missing-fill-in-toast-discount-map', rewardId: pr.rewardId };
      } else {
        const token = await getToastToken();
        toastResult = await applyDiscountToCheck(token, body.orderGuid, body.checkGuid, entry, body.openAmount);
      }
    } catch (e) {
      toastResult = { applied: false, reason: 'exception', error: e.message };
    }
  }

  // -- Log the bartender claim to member history (always). --------------------
  // Points were deducted at redeem-init (when the customer confirmed via the app).
  // This endpoint just records the bartender's claim and clears the pending hold.
  member.history = member.history || [];
  const noteParts = [pr.rewardName, '(code ' + code + ')'];
  if (toastResult.applied) {
    noteParts.push('· Toast check #' + (body.checkGuid || '').slice(0, 8));
  } else if (body.checkGuid) {
    noteParts.push('· Toast apply failed (' + (toastResult.reason || toastResult.status || 'err') + ')');
  } else {
    noteParts.push('· honored at bar');
  }
  member.history.push({
    at: new Date().toISOString(),
    action: 'redeem-claimed',
    delta: 0,
    by: 'staff-redeem',
    note: noteParts.join(' '),
    rewardId: pr.rewardId,
    toastOrderGuid: body.orderGuid || null,
    toastCheckGuid: body.checkGuid || null,
    toastApplied: !!toastResult.applied,
  });
  delete member.pendingRedemption;
  json.lastUpdated = new Date().toISOString().split('T')[0];

  const content = Buffer.from(JSON.stringify(json, null, 2)).toString('base64');
  const put = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
    message: 'redeem: ' + member.name + ' used ' + pr.rewardName + ' (-' + pr.points + ' pts)' + (toastResult.applied ? ' [toast]' : ''),
    content: content,
    sha: sha,
  });
  if (put.status !== 200 && put.status !== 201) {
    return reply(500, { ok: false, error: 'Save failed: HTTP ' + put.status });
  }

  return reply(200, {
    ok: true,
    member: {
      name: member.name,
      email: member.email,
      tier: member.tier,
    },
    reward: {
      name: pr.rewardName,
      points: pr.points,
    },
    newBalance: member.currentPoints,
    toast: toastResult,
  });
};
