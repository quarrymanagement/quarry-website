// ============================================================================
// apply-tier-discount.js — apply a tier-based perk (Gold 5% / Elite 10% bottle)
//                          to a live Toast check.
//
// POST { adminPassword, memberEmail, perk, orderGuid, checkGuid }
// Returns: { ok, member, perk, toast }
//
// Unlike redeem-claim, this doesn't consume a redemption code or deduct
// points — it's a tier benefit. We just verify the member is at the right
// tier, attach the discount to the check via Toast's appliedDiscounts,
// and log to history.
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

function checkAdmin(p) {
  if (!p) return false;
  if (ADMIN_PASSWORD_HASH) return sha256(p) === ADMIN_PASSWORD_HASH;
  return p === 'quarry2026';
}

function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Tier',
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
  }, { clientId: TOAST_CLIENT_ID, clientSecret: TOAST_SECRET, userAccessType: 'TOAST_MACHINE_CLIENT' });
  if (r.status !== 200 || !r.data.token) throw new Error('Toast auth: HTTP ' + r.status);
  return r.data.token.accessToken;
}

async function applyDiscountToCheck(token, orderGuid, checkGuid, entry) {
  const payload = {
    name: entry.label || 'Quarry Tier Discount',
    discount: { guid: entry.guid },
    processingState: 'PENDING_APPROVAL',
  };
  // FIXED_PCT — Toast computes the amount itself
  const path = '/orders/v2/orders/' + orderGuid + '/checks/' + checkGuid + '/appliedDiscounts';
  const r = await httpsRequest({
    hostname: 'ws-api.toasttab.com', path, method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Toast-Restaurant-External-ID': TOAST_REST_GUID,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  }, payload);
  return { applied: r.status >= 200 && r.status < 300, status: r.status, response: r.data };
}

// Map tier → eligible perks (matches project_quarry_rewards_economics.md):
// Gold: 5% off bottles (gold-bottle)
// Elite: 10% off bottles (elite-bottle)
const TIER_PERKS = {
  gold:  ['gold-bottle'],
  elite: ['gold-bottle', 'elite-bottle'], // Elite can use either, but UI should pick best one
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });

  const memberEmail = (body.memberEmail || '').trim().toLowerCase();
  const perk = (body.perk || '').trim();
  const orderGuid = body.orderGuid;
  const checkGuid = body.checkGuid;
  if (!memberEmail) return reply(400, { ok: false, error: 'memberEmail required' });
  if (!perk) return reply(400, { ok: false, error: 'perk required' });
  if (!orderGuid || !checkGuid) return reply(400, { ok: false, error: 'orderGuid + checkGuid required' });

  if (!TOAST_CLIENT_ID || !TOAST_SECRET || !TOAST_REST_GUID) {
    return reply(500, { ok: false, error: 'Toast env vars missing' });
  }

  // Load member
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
  if (r.status !== 200) return reply(500, { ok: false, error: 'Could not load members' });
  const json = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  const sha = r.data.sha;
  const memberIdx = (json.members || []).findIndex((m) => (m.email || '').toLowerCase() === memberEmail);
  if (memberIdx < 0) return reply(404, { ok: false, error: 'Member not found' });
  const member = json.members[memberIdx];

  // Verify tier eligibility
  const tier = (member.tier || 'standard').toLowerCase();
  const allowed = TIER_PERKS[tier] || [];
  if (!allowed.includes(perk)) {
    return reply(403, { ok: false, error: 'Tier "' + tier + '" not eligible for ' + perk });
  }

  // Load discount map
  const mapR = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/toast-discount-map.json');
  if (mapR.status !== 200) return reply(500, { ok: false, error: 'Could not load discount map' });
  const map = JSON.parse(Buffer.from(mapR.data.content, 'base64').toString('utf8'));
  const entry = map.tierPerks && map.tierPerks[perk];
  if (!entry || !entry.guid) {
    return reply(500, { ok: false, error: 'Toast discount GUID not configured for ' + perk });
  }

  // Apply via Toast
  let toastResult;
  try {
    const token = await getToastToken();
    toastResult = await applyDiscountToCheck(token, orderGuid, checkGuid, entry);
  } catch (e) {
    return reply(502, { ok: false, error: 'Toast: ' + e.message });
  }

  // Log to member history
  member.history = member.history || [];
  member.history.push({
    at: new Date().toISOString(),
    action: 'tier-perk-applied',
    delta: 0,
    by: 'staff-tier-discount',
    note: entry.label + ' · check #' + (checkGuid || '').slice(0, 8) + (toastResult.applied ? '' : ' (Toast ' + toastResult.status + ')'),
    perk: perk,
    toastOrderGuid: orderGuid,
    toastCheckGuid: checkGuid,
    toastApplied: !!toastResult.applied,
  });
  json.lastUpdated = new Date().toISOString().split('T')[0];
  const content = Buffer.from(JSON.stringify(json, null, 2)).toString('base64');
  const put = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
    message: 'tier-perk: ' + member.name + ' used ' + entry.label + (toastResult.applied ? ' [toast]' : ''),
    content, sha,
  });
  if (put.status !== 200 && put.status !== 201) {
    return reply(500, { ok: false, error: 'Save failed: HTTP ' + put.status });
  }

  return reply(200, {
    ok: true,
    member: { name: member.name, email: member.email, tier: member.tier },
    perk: { id: perk, label: entry.label, percent: entry.percent },
    toast: toastResult,
  });
};
