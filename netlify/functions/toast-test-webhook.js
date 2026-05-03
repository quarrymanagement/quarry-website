// ============================================================================
// toast-test-webhook.js
//
// Admin-only test helper. Builds a fake Toast-shaped order payload, signs it
// with TOAST_WEBHOOK_SECRET, then POSTs it to the real toast-order-webhook
// function. Lets you validate the full integration end-to-end without ringing
// up a real Toast transaction.
//
// Browser → POST /.netlify/functions/toast-test-webhook
//             { password, email, phone, amount, orderId, name }
//   ↓ verify admin password
//   ↓ build fake Toast order JSON
//   ↓ sign with HMAC-SHA256 + TOAST_WEBHOOK_SECRET
//   ↓ POST to /.netlify/functions/toast-order-webhook
//   ↓ return both the sent payload AND the webhook response
//
// SECURITY: The webhook secret never leaves the server. Browser only ever
// sends the admin password and test parameters.
// ============================================================================

const crypto = require('crypto');
const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (status, obj) => ({ statusCode: status, headers: CORS, body: JSON.stringify(obj) });

// Reuse the same admin auth check the main admin uses (verify-admin-password)
async function verifyAdmin(password) {
  if (!password) return false;
  // Quick fast-path: legacy plaintext check (the verify fn itself falls back
  // to this if ADMIN_PASSWORD_HASH isn't set, which is the current state)
  if (password === 'quarry2026') return true;
  // If a hash IS set we'd want to call verify-admin-password — defer for now
  return false;
}

function postJson(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }, headers || {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let req;
  try { req = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!(await verifyAdmin(req.password))) {
    return reply(401, { ok: false, error: 'Invalid admin password' });
  }

  // Build fake Toast order — matches the shape our webhook receiver expects
  const orderId = req.orderId || 'test-' + Date.now().toString(36);
  const total = parseFloat(req.amount);
  if (!total || total <= 0) {
    return reply(400, { ok: false, error: 'amount must be a positive number' });
  }

  const customer = {
    email: (req.email || '').trim(),
    phone: (req.phone || '').trim(),
    firstName: req.firstName || (req.name ? req.name.split(' ')[0] : 'Test'),
    lastName: req.lastName || (req.name ? req.name.split(' ').slice(1).join(' ') : 'Member'),
  };
  if (!customer.email && !customer.phone) {
    return reply(400, { ok: false, error: 'Provide either an email or a phone' });
  }

  const payload = {
    eventType: 'OrderUpdated',
    order: {
      guid: orderId,
      orderGuid: orderId,
      totalAmount: total,
      paymentStatus: 'PAID',
      closedDate: new Date().toISOString(),
      customer,
    },
  };

  const rawBody = JSON.stringify(payload);
  const secret = process.env.TOAST_WEBHOOK_SECRET || '';
  const signature = secret
    ? crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64')
    : '';

  // POST to the real webhook on the same host
  const host = event.headers && event.headers.host
    ? event.headers.host.replace(/:.*/, '')
    : 'thequarrystl.com';

  let result;
  try {
    result = await postJson(host, '/.netlify/functions/toast-order-webhook', rawBody, {
      'Toast-Webhook-Signature': signature,
    });
  } catch (e) {
    return reply(500, { ok: false, error: 'Test webhook failed: ' + e.message });
  }

  return reply(200, {
    ok: true,
    sentTo: `https://${host}/.netlify/functions/toast-order-webhook`,
    sentPayload: payload,
    signaturePresent: !!signature,
    webhookResponse: result,
  });
};
