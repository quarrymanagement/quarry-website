// ============================================================================
// diag-toast.js — admin diagnostic to confirm Toast integration health.
//
// GET /.netlify/functions/diag-toast?adminPassword=...
//
// Reports:
//   1. Whether the four Toast env vars are present
//   2. Whether we can authenticate against the Toast API
//   3. The restaurant identity Toast returns for our GUID (sanity check)
//   4. Any webhook subscriptions Toast has on file (the answer to
//      "is Toast actually configured to call our webhook?")
//   5. A sample recent order from Toast's API (proves connectivity end-to-end)
//
// Once wired this can stay as an ongoing health check.
//
// redeploy-marker: 2026-05-21 — pick up rotated TOAST_CLIENT_* env vars
// ============================================================================
const crypto = require('crypto');
const https  = require('https');
const { wrap } = require('./_sentry');

const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const TOAST_CLIENT_ID     = process.env.TOAST_CLIENT_ID || '';
const TOAST_SECRET        = process.env.TOAST_CLIENT_SECRET || '';
const TOAST_REST_GUID     = process.env.TOAST_RESTAURANT_GUID || '';
const TOAST_WEBHOOK_SECRET = process.env.TOAST_WEBHOOK_SECRET || '';
const EXPECTED_WEBHOOK_URL = 'https://thequarrystl.com/.netlify/functions/toast-order-webhook';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

function req(opts, body) {
  return new Promise((resolve) => {
    const r = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d || '{}'); } catch (_) { parsed = d.slice(0, 400); }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    r.on('error', (e) => resolve({ status: 0, data: { error: e.message } }));
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

async function toastAuth() {
  return req({
    hostname: 'ws-api.toasttab.com',
    path: '/authentication/v1/authentication/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    clientId: TOAST_CLIENT_ID,
    clientSecret: TOAST_SECRET,
    userAccessType: 'TOAST_MACHINE_CLIENT',
  });
}

async function toastGet(path, token) {
  return req({
    hostname: 'ws-api.toasttab.com',
    path,
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Toast-Restaurant-External-ID': TOAST_REST_GUID,
    },
  });
}

exports.handler = wrap('diag-toast', async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const q = event.queryStringParameters || {};
  if (!checkAdmin(q.adminPassword)) return reply(401, { ok: false, error: 'auth' });

  const out = {
    ok: true,
    checks: {},
    expectedWebhookUrl: EXPECTED_WEBHOOK_URL,
  };

  // 1. Env-var presence + length (length-only — never exposes the value)
  out.checks.envVars = {
    TOAST_CLIENT_ID:       { present: !!TOAST_CLIENT_ID, length: (TOAST_CLIENT_ID || '').length, expectedLength: 32 },
    TOAST_CLIENT_SECRET:   { present: !!TOAST_SECRET, length: (TOAST_SECRET || '').length, expectedLength: 64 },
    TOAST_RESTAURANT_GUID: { present: !!TOAST_REST_GUID, length: (TOAST_REST_GUID || '').length, expectedLength: 36 },
    TOAST_WEBHOOK_SECRET:  { present: !!TOAST_WEBHOOK_SECRET, length: (TOAST_WEBHOOK_SECRET || '').length, expectedLength: 32 },
  };
  if (!TOAST_CLIENT_ID || !TOAST_SECRET || !TOAST_REST_GUID) {
    out.ok = false;
    out.checks.envVars.note = 'Missing one or more Toast env vars; cannot proceed.';
    return reply(200, out);
  }

  // 2. Auth
  const auth = await toastAuth();
  out.checks.auth = {
    httpStatus: auth.status,
    ok: auth.status >= 200 && auth.status < 300,
  };
  const token = auth.data && auth.data.token && auth.data.token.accessToken;
  if (!token) {
    out.ok = false;
    out.checks.auth.error = auth.data && auth.data.message ? auth.data.message : 'No accessToken returned';
    out.checks.auth.bodySample = typeof auth.data === 'string' ? auth.data : JSON.stringify(auth.data).slice(0, 400);
    return reply(200, out);
  }

  // 3. Restaurant identity (sanity)
  const restInfo = await toastGet('/restaurants/v1/restaurants/' + TOAST_REST_GUID, token);
  out.checks.restaurant = {
    httpStatus: restInfo.status,
    ok: restInfo.status === 200,
    name: restInfo.data && restInfo.data.general && restInfo.data.general.name,
    location: restInfo.data && restInfo.data.location && restInfo.data.location.address1,
  };

  // 4. Webhook subscriptions — answers "is Toast configured to call us?"
  //    Toast's Webhooks API isn't part of the Public API for every account, so
  //    this may return 401/404 even when the integration is healthy. In that
  //    case the only way to know is the Toast dashboard.
  const subs = await toastGet('/orders/v2/webhookSubscriptions', token);
  if (subs.status === 200) {
    const list = Array.isArray(subs.data) ? subs.data : (subs.data && subs.data.subscriptions) || [];
    out.checks.webhookSubscriptions = {
      httpStatus: 200,
      count: list.length,
      ourUrlConfigured: list.some((s) => s && s.url === EXPECTED_WEBHOOK_URL),
      all: list.map((s) => ({ url: s.url, eventTypes: s.eventTypes || s.events })),
    };
  } else {
    out.checks.webhookSubscriptions = {
      httpStatus: subs.status,
      note: 'Webhook-subscription read may not be exposed for this account; check Toast dashboard directly. Endpoint hit: /orders/v2/webhookSubscriptions',
      bodySample: typeof subs.data === 'string' ? subs.data : JSON.stringify(subs.data).slice(0, 400),
    };
  }

  // 5. Recent orders — proves API connectivity and that orders are happening
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const orders = await toastGet('/orders/v2/orders?startDate=' + encodeURIComponent(since), token);
  if (orders.status === 200) {
    const list = Array.isArray(orders.data) ? orders.data : [];
    out.checks.recentOrders = {
      httpStatus: 200,
      lookbackHours: 24,
      count: list.length,
      sampleGuids: list.slice(0, 3).map((o) => o.guid || o.orderGuid || '(no guid)'),
    };
  } else {
    out.checks.recentOrders = {
      httpStatus: orders.status,
      note: 'Could not fetch recent orders. Possibly OK if there have been no orders in the last 24h.',
    };
  }

  return reply(200, out);
});
