// ============================================================================
// list-quarryfest-vendors.js
//
// Admin-only: returns all Quarry Fest vendor registrations (pending or
// booked). Single event (Sat Nov 7, 2026), so this is one fixed blob key,
// not a date-range scan like pavilions/food trucks.
//
// GET /.netlify/functions/list-quarryfest-vendors?token=...
// Returns: { ok: true, vendors: [...] }
// ============================================================================

const crypto = require('crypto');
const { readBlob } = require('./_blobs');

const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const STAFF_SECRET = process.env.STAFF_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168;
const ALLOWED_ROLES = ['owner', 'events_staff'];
const BOOKINGS_PATH = 'quarryfest-vendors/2026-11-07';

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

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'GET only' }) };

  const q = event.queryStringParameters || {};
  const auth = verifyAnyToken(q.token);
  if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

  const data = (await readBlob(BOOKINGS_PATH)) || { vendors: [] };
  const vendors = (data.vendors || []).slice().sort((a, b) => (a.registeredAt || '').localeCompare(b.registeredAt || ''));

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, count: vendors.length, vendors }) };
};
