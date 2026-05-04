// ============================================================================
// list-open-checks.js — return all currently-OPEN Toast checks for today
//
// POST { adminPassword }
// Returns: [{ orderGuid, checkGuid, displayNumber, openedAt, amount,
//             totalAmount, itemCount, server, source, customerEmail }]
//
// Used by bartender.html so the bartender can pick which check to apply a
// reward / tier discount to (Option B from the discount-apply UX design).
//
// ENV: TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, TOAST_RESTAURANT_GUID,
//      ADMIN_PASSWORD_HASH (or quarry2026 fallback)
// ============================================================================
const crypto = require('crypto');
const https = require('https');

const TOAST_CLIENT_ID = process.env.TOAST_CLIENT_ID || '';
const TOAST_SECRET = process.env.TOAST_CLIENT_SECRET || '';
const TOAST_REST_GUID = process.env.TOAST_RESTAURANT_GUID || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

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

function ctYmdNow() {
  // Toast's businessDate is in restaurant local (CT)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).replace(/-/g, '');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });
  if (!TOAST_CLIENT_ID || !TOAST_SECRET || !TOAST_REST_GUID) {
    return reply(500, { ok: false, error: 'Toast env vars missing' });
  }

  let token;
  try { token = await getToastToken(); }
  catch (e) { return reply(502, { ok: false, error: e.message }); }

  // Walk pages of today's orders, filter to checks that are still open
  const businessDate = body.businessDate || ctYmdNow();
  const open = [];
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
    if (r.status !== 200 || !Array.isArray(r.data)) break;
    if (r.data.length === 0) break;
    for (const order of r.data) {
      if (order.voided || order.voidDate) continue;
      for (const check of (order.checks || [])) {
        if (check.voided || check.paidDate || check.paymentStatus === 'CLOSED') continue;
        const items = (check.selections || []).filter((s) => !s.voided).length;
        const totalAmount = check.totalAmount || ((check.amount || 0) + (check.taxAmount || 0));
        open.push({
          orderGuid: order.guid,
          checkGuid: check.guid,
          orderNumber: order.displayNumber,
          checkNumber: check.displayNumber,
          tabName: check.tabName,
          openedAt: check.openedDate || order.openedDate,
          amount: check.amount || 0,
          taxAmount: check.taxAmount || 0,
          totalAmount: totalAmount,
          itemCount: items,
          customerEmail: (check.customer && check.customer.email) || null,
          customerFirst: (check.customer && check.customer.firstName) || null,
          customerLast: (check.customer && check.customer.lastName) || null,
        });
      }
    }
    if (r.data.length < 100) break;
  }

  // Sort by most recently opened
  open.sort((a, b) => new Date(b.openedAt || 0) - new Date(a.openedAt || 0));

  return reply(200, { ok: true, businessDate, count: open.length, checks: open });
};
