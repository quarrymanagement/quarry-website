// ============================================================================
// list-square-payments-debug.js
//
// TEMPORARY diagnostic: admin-only, read-only. Lists recent Square payments
// in a date range with their order's line items/metadata, so staff/Claude
// can compare what Square actually charged against what got recorded in
// events.json -- without dashboard access or ever seeing the API token.
//
// GET /.netlify/functions/list-square-payments-debug?token=...&beginTime=ISO&endTime=ISO
// ============================================================================

const crypto = require('crypto');
const https = require('https');

const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const STAFF_SECRET = process.env.STAFF_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168;
const ALLOWED_ROLES = ['owner', 'events_staff'];

function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }
function verifyAnyToken(token) {
  if (!token) return { ok: false };
  const parts = String(token).split('.');
  if (parts.length === 2) {
    const [issued, sig] = parts;
    if (!ADMIN_SECRET || !issued || !sig || hmac(issued, ADMIN_SECRET) !== sig) return { ok: false };
    if (!((Date.now() - parseInt(issued, 10)) / 3600000 < SESSION_TTL_HOURS)) return { ok: false };
    return { ok: true, role: 'owner' };
  }
  if (parts.length === 3) {
    const [issued, role, sig] = parts;
    if (!STAFF_SECRET || !issued || !role || !sig || hmac(`${issued}.${role}`, STAFF_SECRET) !== sig) return { ok: false };
    if (!((Date.now() - parseInt(issued, 10)) / 3600000 < SESSION_TTL_HOURS)) return { ok: false };
    return { ok: true, role };
  }
  return { ok: false };
}

function squareApi(method, path) {
  const env = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  const host = env === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
  const opts = {
    hostname: host, path, method,
    headers: {
      'Authorization': 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
      'Square-Version': '2024-12-18',
      'Content-Type': 'application/json',
    }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch (e) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const q = event.queryStringParameters || {};
  const auth = verifyAnyToken(q.token);
  if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

  try {
    const beginTime = q.beginTime || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const endTime = q.endTime || new Date().toISOString();

    let payments = [];
    let cursor = '';
    let guard = 0;
    do {
      const path = `/v2/payments?begin_time=${encodeURIComponent(beginTime)}&end_time=${encodeURIComponent(endTime)}&sort_order=DESC${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
      const res = await squareApi('GET', path);
      if (res.status !== 200) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ ok: false, error: res.body }) };
      payments = payments.concat(res.body.payments || []);
      cursor = res.body.cursor || '';
      guard++;
    } while (cursor && guard < 10);

    const summarized = payments.map((p) => ({
      id: p.id,
      status: p.status,
      amount: p.amount_money,
      createdAt: p.created_at,
      orderId: p.order_id,
      note: p.note,
      receiptUrl: p.receipt_url,
      buyerEmail: p.buyer_email_address,
      cardholderName: p.card_details && p.card_details.card && p.card_details.card.cardholder_name,
    }));

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, count: summarized.length, payments: summarized }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
