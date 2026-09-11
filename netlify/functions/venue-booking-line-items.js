// ============================================================================
// venue-booking-line-items.js
//
// Server-side proxy for the booking edit modal's line-item editor
// (admin/venue-calendar.html). Mirrors venue-day-view.js / venue-booking-write.js's
// auth pattern exactly (admin OR restricted-staff session token), but forwards
// both GET (load items + payment history) and POST (replace items) to the
// venue-booking-line-items Supabase edge function.
//
// GET  /.netlify/functions/venue-booking-line-items?token=...&booking_id=...
// POST /.netlify/functions/venue-booking-line-items
//   Body: { token, booking_id, line_items: [...] }
// ============================================================================
const crypto = require('crypto');

const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const STAFF_SECRET = process.env.STAFF_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168;
const ALLOWED_ROLES = ['owner', 'events_staff'];
const VENUE_AVAILABILITY_KEY = process.env.VENUE_AVAILABILITY_KEY || '';
const SUPABASE_FN_URL = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/venue-booking-line-items';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }

// Verifies either an owner token ("<issued>.<sig>") or a staff token
// ("<issued>.<role>.<sig>") — see verify-admin-password.js for the scheme.
function verifyAnyToken(token) {
  if (!token) return { ok: false };
  const parts = String(token).split('.');

  if (parts.length === 2) {
    const [issued, sig] = parts;
    if (!ADMIN_SECRET || !issued || !sig) return { ok: false };
    if (hmac(issued, ADMIN_SECRET) !== sig) return { ok: false };
    const ageHours = (Date.now() - parseInt(issued, 10)) / (1000 * 3600);
    if (!(ageHours < SESSION_TTL_HOURS)) return { ok: false };
    return { ok: true, role: 'owner' };
  }

  if (parts.length === 3) {
    const [issued, role, sig] = parts;
    if (!STAFF_SECRET || !issued || !role || !sig) return { ok: false };
    if (hmac(`${issued}.${role}`, STAFF_SECRET) !== sig) return { ok: false };
    const ageHours = (Date.now() - parseInt(issued, 10)) / (1000 * 3600);
    if (!(ageHours < SESSION_TTL_HOURS)) return { ok: false };
    return { ok: true, role };
  }

  return { ok: false };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (!VENUE_AVAILABILITY_KEY) return reply(503, { error: 'Venue booking line items are not configured on the server.' });

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    const auth = verifyAnyToken(q.token);
    if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return reply(401, { error: 'unauthorized' });
    if (!q.booking_id) return reply(400, { error: 'missing_field', field: 'booking_id' });
    try {
      const url = SUPABASE_FN_URL + '?booking_id=' + encodeURIComponent(q.booking_id);
      const r = await fetch(url, { headers: { 'x-access-key': VENUE_AVAILABILITY_KEY } });
      const body = await r.json();
      return reply(r.status, body);
    } catch (e) {
      return reply(500, { error: 'exception', message: e.message });
    }
  }

  if (event.httpMethod !== 'POST') return reply(405, { error: 'GET or POST only' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return reply(400, { error: 'invalid_json' });
  }

  const { token, ...forwardBody } = payload;
  const auth = verifyAnyToken(token);
  if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return reply(401, { error: 'unauthorized' });

  try {
    const r = await fetch(SUPABASE_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-key': VENUE_AVAILABILITY_KEY },
      body: JSON.stringify(forwardBody),
    });
    const body = await r.json();
    return reply(r.status, body);
  } catch (e) {
    return reply(500, { error: 'exception', message: e.message });
  }
};
