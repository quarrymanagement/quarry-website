// ============================================================================
// venue-booking-line-items.js
//
// Server-side proxy for the booking edit modal's line-item editor
// (admin/venue-calendar.html). Mirrors venue-day-view.js / venue-booking-write.js's
// auth pattern exactly, but forwards both GET (load items + payment history)
// and POST (replace items) to the venue-booking-line-items Supabase edge
// function.
//
// GET  /.netlify/functions/venue-booking-line-items?token=...&booking_id=...
// POST /.netlify/functions/venue-booking-line-items
//   Body: { token, booking_id, line_items: [...] }
// ============================================================================
const crypto = require('crypto');

const SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const SESSION_TTL_HOURS = 168;
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

function verifyToken(token) {
  if (!SECRET || !token) return false;
  const [issued, sig] = String(token).split('.');
  if (!issued || !sig) return false;
  if (hmac(issued, SECRET) !== sig) return false;
  const ageHours = (Date.now() - parseInt(issued, 10)) / (1000 * 3600);
  return ageHours < SESSION_TTL_HOURS;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (!VENUE_AVAILABILITY_KEY) return reply(503, { error: 'Venue booking line items are not configured on the server.' });

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (!verifyToken(q.token)) return reply(401, { error: 'unauthorized' });
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
  if (!verifyToken(token)) return reply(401, { error: 'unauthorized' });

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
