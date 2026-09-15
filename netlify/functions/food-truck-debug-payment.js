// ============================================================================
// food-truck-debug-payment.js
//
// TEMPORARY diagnostic: admin-only, read-only. Looks up a Square order by
// its payment link ID and reports back the order + any payments on it, so
// staff/Claude can see what Square actually did with a checkout without
// needing direct Square dashboard access or ever seeing the API token.
//
// GET /.netlify/functions/food-truck-debug-payment?token=...&paymentLinkId=...
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
    const paymentLinkId = q.paymentLinkId;
    if (!paymentLinkId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'paymentLinkId required' }) };

    const linkRes = await squareApi('GET', '/v2/online-checkout/payment-links/' + paymentLinkId);
    const orderId = linkRes.body.payment_link && linkRes.body.payment_link.order_id;

    let order = null;
    let payments = [];
    if (orderId) {
      const orderRes = await squareApi('GET', '/v2/orders/' + orderId);
      order = orderRes.body.order || null;
      const paymentIds = (order && order.tenders || []).map((t) => t.payment_id || t.id).filter(Boolean);
      for (const pid of paymentIds) {
        const pRes = await squareApi('GET', '/v2/payments/' + pid);
        payments.push(pRes.body.payment || pRes.body);
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: true,
      paymentLinkUrl: linkRes.body.payment_link && linkRes.body.payment_link.url,
      order: order ? { id: order.id, state: order.state, metadata: order.metadata, tenderCount: (order.tenders || []).length } : null,
      payments: payments.map((p) => ({ id: p.id, status: p.status, amount: p.amount_money, createdAt: p.created_at })),
    }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
