// ============================================================================
// process-pending-scans.js — hourly cron + admin trigger for pending queue
//
// Walks pending-scans.json, retries every "pending" item against Toast.
// Credits matches, expires anything past TTL, leaves still-pending items
// for the next run.
//
// Triggered by:
//   - Netlify Scheduled Function (hourly via netlify.toml schedule)
//   - Admin/manual: POST { adminPassword } to call directly
//
// ENV: GITHUB_TOKEN, TOAST_*, ADMIN_PASSWORD_HASH (or quarry2026 fallback),
//      SENDGRID_API_KEY (for expiry notification)
// ============================================================================

const crypto = require('crypto');
const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const TOAST_CLIENT_ID = process.env.TOAST_CLIENT_ID || '';
const TOAST_SECRET = process.env.TOAST_CLIENT_SECRET || '';
const TOAST_REST_GUID = process.env.TOAST_RESTAURANT_GUID || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';

const PENDING_TTL_HOURS = 6;
const SCAN_WINDOW_HOURS = 12;
const MIN_TAB_USD = 20;
const TOTAL_TOLERANCE = 1.0;

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

function gh(method, path, body) {
  return httpsRequest({
    hostname: 'api.github.com', path, method,
    headers: {
      'Authorization': 'token ' + GITHUB_TOKEN,
      'User-Agent': 'Quarry-Pending-Cron',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
  }, body);
}



function ctOffsetSuffix(yyyymmdd) {
  if (!yyyymmdd || typeof yyyymmdd !== 'string') return '-05:00';
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  if (!y || !m || !d) return '-05:00';
  const probe = new Date(Date.UTC(y, m - 1, d, 18, 0, 0));
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' });
    const tzAbbr = (fmt.formatToParts(probe).find((p) => p.type === 'timeZoneName') || {}).value || 'CDT';
    return tzAbbr === 'CST' ? '-06:00' : '-05:00';
  } catch (_) {
    return (m >= 3 && m <= 10) ? '-05:00' : '-06:00';
  }
}

// Parse transactionAt safely. Legacy entries may lack timezone — treat those as CT.
function parseTransactionTs(s) {
  if (!s) return NaN;
  // If it has Z or explicit offset, use as-is
  if (/Z$|[+-]\d{2}:\d{2}$/.test(s)) return new Date(s).getTime();
  // Otherwise treat as CT — extract date and append CT offset
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})T?(\d{2}:\d{2})?/);
  if (!m) return NaN;
  const dateIso = m[1];
  const timeIso = m[2] || '23:59';
  return new Date(dateIso + 'T' + timeIso + ':00' + ctOffsetSuffix(dateIso)).getTime();
}

async function loadJson(filePath) {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/' + filePath);
  if (r.status === 404) return { sha: null, json: null };
  if (r.status !== 200) throw new Error('GitHub load ' + filePath + ': HTTP ' + r.status);
  return { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
}

async function saveJson(filePath, json, sha, message) {
  const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64');
  const body = sha ? { message, content, sha } : { message, content };
  const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/' + filePath, body);
  if (r.status !== 200 && r.status !== 201) throw new Error('GitHub save ' + filePath + ': HTTP ' + r.status);
  return r.data.content && r.data.content.sha;
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

async function findToastOrder(checkNumber, businessDate, token) {
  const target = String(checkNumber).replace(/^#?/, '');
  for (let page = 1; page <= 10; page++) {
    const r = await httpsRequest({
      hostname: 'ws-api.toasttab.com',
      path: '/orders/v2/ordersBulk?businessDate=' + businessDate + '&pageSize=100&page=' + page,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Toast-Restaurant-External-ID': TOAST_REST_GUID,
        'Accept': 'application/json',
      },
    });
    if (r.status !== 200 || !Array.isArray(r.data)) throw new Error('Toast lookup: HTTP ' + r.status);
    if (r.data.length === 0) return null;
    for (const order of r.data) {
      for (const check of (order.checks || [])) {
        const dn = String(check.displayNumber || check.tabName || '').replace(/^#?/, '');
        if (dn === target) return { order, check };
      }
    }
    if (r.data.length < 100) return null;
  }
  return null;
}

function checkSubtotal(c) {
  if (!c) return 0;
  if (typeof c.amount === 'number') return c.amount;
  if (typeof c.subtotal === 'number') return c.subtotal;
  return 0;
}
function checkPreTipTotal(c) {
  if (!c) return 0;
  const sub = checkSubtotal(c);
  const tax = (typeof c.taxAmount === 'number') ? c.taxAmount : (c.tax || 0);
  if (sub) return sub + tax;
  if (typeof c.totalAmount === 'number') return c.totalAmount - (c.tipAmount || 0);
  return 0;
}
function checkTotal(c) {
  if (!c) return 0;
  return c.totalAmount || (checkSubtotal(c) + (c.taxAmount || 0) + (c.tipAmount || 0)) || 0;
}
function tierMult(tier) {
  return ({ standard: 1.0, silver: 1.1, gold: 1.25, elite: 1.5, platinum: 1.5 }[tier]) || 1.0;
}

async function notifyExpiry(toEmail, checkNumber) {
  if (!SENDGRID_KEY) return;
  try {
    await httpsRequest({
      hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SENDGRID_KEY,
        'Content-Type': 'application/json',
      },
    }, {
      personalizations: [{ to: [{ email: toEmail }] }],
      from: { email: 'management@thequarrystl.com', name: 'The Quarry' },
      subject: 'Your receipt scan needs a manual check',
      content: [{
        type: 'text/plain',
        value: `Hi from The Quarry,

We tried to verify your receipt scan for check #${checkNumber}, but our system couldn't find it in Toast after several hours of retrying.

If this was a real visit at The Quarry, please reply to this email or text us — we'll credit your points manually within a day.

Thanks for being part of the Quarry family.

— The Quarry`,
      }],
    });
  } catch (_) { /* email failure shouldn't block cron */ }
}

async function processAllPending() {
  const pendingFile = await loadJson('pending-scans.json');
  if (!pendingFile.json) return { processed: 0, credited: 0, expired: 0, mismatched: 0 };
  const items = pendingFile.json.items || [];
  const pendingOnly = items.filter((it) => it.status === 'pending');
  if (!pendingOnly.length) return { processed: 0, credited: 0, expired: 0, mismatched: 0 };

  const toastToken = await getToastToken();
  let creditedFile = null, creditedJson = null;
  let membersFile = null, membersJson = null;
  let dirty = false, credited = 0, expired = 0, mismatched = 0;

  for (const it of pendingOnly) {
    const ageHours = (Date.now() - parseTransactionTs(it.transactionAt)) / 3600000;

    // Expire if past total window (PENDING_TTL + scan window grace)
    if (ageHours > PENDING_TTL_HOURS + SCAN_WINDOW_HOURS) {
      it.status = 'expired';
      it.decidedAt = new Date().toISOString();
      dirty = true; expired++;
      await notifyExpiry(it.memberEmail, it.checkNumber);
      continue;
    }

    let match;
    try { match = await findToastOrder(it.checkNumber, it.businessDate, toastToken); }
    catch (_) { continue; }

    if (!match) {
      it.tryCount = (it.tryCount || 1) + 1;
      it.lastTriedAt = new Date().toISOString();
      dirty = true;
      continue;
    }

    const toastSubtotal = checkSubtotal(match.check);
    const toastPreTip = checkPreTipTotal(match.check);
    const toastTotal = checkTotal(match.check);
    if (it.ocrSubtotal != null && Math.abs(toastSubtotal - it.ocrSubtotal) > TOTAL_TOLERANCE) {
      it.status = 'mismatch';
      it.decidedAt = new Date().toISOString();
      dirty = true; mismatched++;
      continue;
    }
    if (toastPreTip < MIN_TAB_USD) {
      it.status = 'below-minimum';
      it.decidedAt = new Date().toISOString();
      dirty = true;
      continue;
    }

    if (!creditedFile) {
      creditedFile = await loadJson('credited-orders.json');
      creditedJson = creditedFile.json || { orders: [] };
    }
    if (creditedJson.orders.some((o) => o.orderId === match.order.guid)) {
      it.status = 'duplicate';
      it.decidedAt = new Date().toISOString();
      dirty = true;
      continue;
    }
    if (!membersFile) {
      membersFile = await loadJson('members.json');
      membersJson = membersFile.json;
    }
    const member = (membersJson.members || []).find((x) => (x.email || '').toLowerCase() === (it.memberEmail || '').toLowerCase());
    if (!member) continue;

    const tier = member.tier || 'standard';
    const mult = tierMult(tier);
    const earnBasis = toastPreTip;
    const basePts = Math.round(earnBasis * 10);
    const visitBonus = earnBasis >= MIN_TAB_USD ? 10 : 0;
    const totalPts = Math.round((basePts + visitBonus) * mult);

    member.currentPoints = (member.currentPoints || 0) + totalPts;
    member.lifetimePoints = (member.lifetimePoints || 0) + totalPts;
    member.lastVisitAt = new Date().toISOString();
    member.history = member.history || [];
    member.history.push({
      at: new Date().toISOString(),
      action: 'earn',
      source: 'receipt-scan-cron',
      delta: totalPts,
      orderId: match.order.guid,
      checkNumber: it.checkNumber,
      spendUsd: earnBasis,
      finalTotalUsd: toastTotal,
      subtotalUsd: toastSubtotal,
      tier, multiplier: mult,
      note: 'Receipt scan (cron retry, ' + (it.tryCount || 1) + ' attempts)',
    });

    creditedJson.orders.push({
      orderId: match.order.guid,
      checkNumber: it.checkNumber,
      memberEmail: member.email,
      subtotal: toastSubtotal,
      preTipTotal: earnBasis,
      finalTotal: toastTotal,
      points: totalPts,
      creditedAt: new Date().toISOString(),
      fromQueue: true,
    });

    it.status = 'credited';
    it.decidedAt = new Date().toISOString();
    it.creditedPoints = totalPts;
    dirty = true; credited++;
  }

  if (credited > 0) {
    await saveJson('members.json', membersJson, membersFile.sha,
      `cron: ${credited} pending scans credited`);
    await saveJson('credited-orders.json', creditedJson, creditedFile.sha,
      `cron: ${credited} pending scans credited`);
  }
  if (dirty) {
    await saveJson('pending-scans.json', pendingFile.json, pendingFile.sha,
      `cron: ${credited} credited, ${expired} expired, ${mismatched} mismatched`);
  }
  return { processed: pendingOnly.length, credited, expired, mismatched };
}

exports.handler = async (event) => {
  // Allow scheduled-function invocation (no body) AND admin-triggered POST
  const isScheduled = event.headers && event.headers['x-netlify-trigger-source'] === 'scheduled';

  if (!isScheduled) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }
    if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });
  }

  if (!GITHUB_TOKEN || !TOAST_CLIENT_ID || !TOAST_SECRET || !TOAST_REST_GUID) {
    return reply(500, { ok: false, error: 'Server not fully configured' });
  }

  try {
    const result = await processAllPending();
    return reply(200, { ok: true, ...result, ranAt: new Date().toISOString() });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};

exports.config = {
  schedule: '@hourly',
};
