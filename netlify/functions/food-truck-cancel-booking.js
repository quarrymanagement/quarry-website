// ============================================================================
// food-truck-cancel-booking.js
//
// Admin-only: removes one booking (pending or already paid) from a date,
// freeing that slot back up. Does not touch Square or issue any refund --
// if the truck already paid, that's a separate manual step in the Square
// dashboard; this only updates The Quarry's own records.
//
// POST /.netlify/functions/food-truck-cancel-booking
// Auth: staff/owner session token (same scheme as every other admin action)
// Body: { token, bookingId, date }
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

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const auth = verifyAnyToken(body.token);
    if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
    }

    const bookingId = String(body.bookingId || '').trim();
    const date = String(body.date || '').trim();
    if (!bookingId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'bookingId and date (YYYY-MM-DD) are required' }) };
    }

    const path = 'food-truck-bookings/' + date;
    const existing = (await readBlob(path)) || { bookings: [] };
    const bookings = existing.bookings || [];
    const idx = bookings.findIndex((b) => b.bookingId === bookingId);
    if (idx === -1) return { statusCode: 404, headers: CORS, body: JSON.stringify({ ok: false, error: 'booking not found for that date' }) };

    const removed = bookings.splice(idx, 1)[0];
    await writeBlob(path, { bookings });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, removed }) };
  } catch (err) {
    console.error('food-truck-cancel-booking error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
