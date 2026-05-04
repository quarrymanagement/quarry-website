// ============================================================================
// toast-debug-orders.js — admin diagnostic: dump Toast ordersBulk response
//
// POST { adminPassword, businessDate (YYYYMMDD) }
//   Returns { orders: [{ guid, checks: [{ displayNumber, tabName, totalAmount,
//     subtotal, taxAmount, tipAmount, payments }] }] }
//
// Used to debug why scan-receipt can't find a known check.
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
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b, null, 2) });

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
        try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}'), raw: d, headers: res.headers }); }
        catch (_) { resolve({ status: res.statusCode, data: d, raw: d, headers: res.headers }); }
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
    clientId: TOAST_CLIENT_ID,
    clientSecret: TOAST_SECRET,
    userAccessType: 'TOAST_MACHINE_CLIENT',
  });
  if (r.status !== 200 || !r.data.token) {
    throw new Error('Toast auth failed: HTTP ' + r.status + ' / ' + r.raw.substring(0, 200));
  }
  return r.data.token.accessToken;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin(body.adminPassword)) {
    return reply(401, { ok: false, error: 'Invalid admin password' });
  }
  if (!TOAST_CLIENT_ID || !TOAST_SECRET || !TOAST_REST_GUID) {
    return reply(500, { ok: false, error: 'Toast env vars missing' });
  }
  const businessDate = String(body.businessDate || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(businessDate)) {
    return reply(400, { ok: false, error: 'businessDate must be YYYYMMDD (8 digits)' });
  }

  let token;
  try { token = await getToastToken(); }
  catch (e) { return reply(500, { ok: false, error: e.message }); }

  // Try multiple endpoints to compare results
  const results = {};
  const endpoints = [
    { name: 'ordersBulk', path: '/orders/v2/ordersBulk?businessDate=' + businessDate + '&pageSize=100' },
    { name: 'orders',     path: '/orders/v2/orders?businessDate=' + businessDate + '&pageSize=100' },
  ];
  for (const ep of endpoints) {
    const r = await httpsRequest({
      hostname: 'ws-api.toasttab.com',
      path: ep.path,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Toast-Restaurant-External-ID': TOAST_REST_GUID,
        'Accept': 'application/json',
      },
    });
    results[ep.name] = {
      httpStatus: r.status,
      isArray: Array.isArray(r.data),
      count: Array.isArray(r.data) ? r.data.length : null,
      sample: Array.isArray(r.data) && r.data.length ? r.data[0] : null,
      // Compact summary: list of checks across all orders
      checkSummaries: Array.isArray(r.data)
        ? r.data.flatMap((order) =>
            (order.checks || []).map((check) => ({
              orderGuid: order.guid,
              checkGuid: check.guid,
              displayNumber: check.displayNumber,
              tabName: check.tabName,
              amount: check.amount,
              subtotal: check.subtotal,
              taxAmount: check.taxAmount,
              tipAmount: check.tipAmount,
              totalAmount: check.totalAmount,
              paymentCount: (check.payments || []).length,
            }))
          )
        : [],
      // Raw error if not array
      errorBody: !Array.isArray(r.data) ? (r.raw || '').substring(0, 500) : null,
    };
  }

  return reply(200, {
    ok: true,
    businessDate,
    restaurantGuid: TOAST_REST_GUID,
    results,
  });
};
