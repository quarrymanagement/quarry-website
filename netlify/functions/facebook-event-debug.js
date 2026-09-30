// ============================================================================
// facebook-event-debug.js
//
// TEMPORARY diagnostic: admin-only. Checks whether this Page's existing
// META_PAGE_ACCESS_TOKEN actually has permission to create real Facebook
// Events via the Graph API (POST /{page-id}/events) before building a full
// feature around it -- Meta restricted this endpoint for most apps years
// ago, so this confirms feasibility first rather than assuming it works.
//
// GET /.netlify/functions/facebook-event-debug?token=...
// ============================================================================

const crypto = require('crypto');
const fetch = require('node-fetch');

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

const PAGE_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || '';
const PAGE_ID = process.env.META_PAGE_ID || '';
const API_BASE = 'https://graph.facebook.com/v18.0';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const q = event.queryStringParameters || {};
  const auth = verifyAnyToken(q.token);
  if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

  if (!PAGE_TOKEN || !PAGE_ID) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, reason: 'META_PAGE_ACCESS_TOKEN or META_PAGE_ID not configured' }) };
  }

  try {
    // 1. What scopes does this token actually have?
    const debugRes = await fetch(`${API_BASE}/debug_token?input_token=${encodeURIComponent(PAGE_TOKEN)}&access_token=${encodeURIComponent(PAGE_TOKEN)}`);
    const debugData = await debugRes.json();

    // 2. Does the Page's /events edge even respond to a read (GET), regardless of write permission?
    const readRes = await fetch(`${API_BASE}/${PAGE_ID}/events?access_token=${encodeURIComponent(PAGE_TOKEN)}`);
    const readData = await readRes.json();

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: true,
      tokenScopes: (debugData.data && debugData.data.scopes) || null,
      tokenDebugRaw: debugData,
      eventsReadStatus: readRes.status,
      eventsReadRaw: readData,
    }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
