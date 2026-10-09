// ============================================================================
// admin-backfill-pavilion-booking.js
//
// Admin-only: manually writes a pavilion booking record into the same
// pavilion-bookings/{dateKey} blob that square-webhook.js's
// handlePavilionBooking() writes to. Exists for the case where a real
// Square payment succeeded but the webhook never fired/failed silently, so
// the booking never made it into storage even though the customer paid.
// Also usable for a plain manual block (no payment), matching the existing
// "admin-<uuid>" entries already in use.
//
// POST /.netlify/functions/admin-backfill-pavilion-booking
// Body: { token, pavilion, time, date, customerName, customerEmail,
//         customerPhone, amountPaid, paymentId, source }
// paymentId/source optional -- if omitted, generates an "admin-<uuid>" id
// and source:"admin", matching the existing manual-block convention.
// Dedupes by paymentId (or generated id) the same way the webhook does.
// ============================================================================

const crypto = require('crypto');
const { readBlob, writeBlob } = require('./_blobs');
const { syncDay } = require('./_venue-sync-shared');

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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'invalid JSON' }) }; }

  const auth = verifyAnyToken(body.token);
  if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

  const m = body;
  if (!m.pavilion || !m.time || !m.date) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'pavilion, time, and date are required' }) };
  }

  try {
    const dateKey = String(m.date).replace(/\//g, '-');
    const path = 'pavilion-bookings/' + dateKey;
    const existing = await readBlob(path) || { bookings: [] };
    let bookings = existing.bookings || [];

    const paymentId = m.paymentId || ('admin-' + crypto.randomUUID());
    bookings = bookings.filter((b) => (b.paymentId || '') !== paymentId);
    bookings.push({
      paymentId,
      pavilion: String(m.pavilion),
      time: m.time,
      date: m.date,
      dateKey,
      customerName: m.customerName || '',
      customerEmail: m.customerEmail || '',
      customerPhone: m.customerPhone || '',
      amountPaid: m.amountPaid || 'N/A (admin block)',
      bookedAt: new Date().toISOString(),
      source: m.source || (m.paymentId ? 'square' : 'admin'),
    });
    await writeBlob(path, { bookings });

    // Mirror onto the venue calendar right away (best effort, capped at 6s so a
    // slow database can never hang this tool; the 10-minute sync is the backstop).
    try { await Promise.race([syncDay('pavilion', dateKey), new Promise((r) => setTimeout(r, 6000))]); } catch (_) { /* backstop sync will catch it */ }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, path, paymentId, bookingCount: bookings.length }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(e.message || e) }) };
  }
};
