// ============================================================================
// admin-remove-pavilion-booking.js
//
// Admin-only: removes a single booking from pavilion-bookings/{date} by
// paymentId. Pairs with admin-backfill-pavilion-booking.js (manual
// add/override) so staff can undo a mistaken manual entry. Works on any
// entry regardless of source, but is really meant for "admin" (manual)
// bookings -- removing a real "square" one doesn't refund the charge, it
// only removes the record, so the UI should discourage that.
//
// POST /.netlify/functions/admin-remove-pavilion-booking
// Body: { token, date, paymentId }
// ============================================================================

const crypto = require('crypto');
const { readBlob, writeBlob } = require('./_blobs');

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

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'invalid JSON' }) }; }

  const auth = verifyAnyToken(body.token);
  if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

  const date = String(body.date || '').trim();
  const paymentId = String(body.paymentId || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !paymentId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'date (YYYY-MM-DD) and paymentId are required' }) };
  }

  try {
    const path = 'pavilion-bookings/' + date;
    const existing = (await readBlob(path)) || { bookings: [] };
    const before = (existing.bookings || []).length;
    const bookings = (existing.bookings || []).filter((b) => (b.paymentId || '') !== paymentId);
    await writeBlob(path, { bookings });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, removed: before - bookings.length, remaining: bookings.length }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(e.message || e) }) };
  }
};
