// ============================================================================
// venue-booking-invoice-create.js
//
// Server-side proxy for sending a Square invoice for an internal venue
// booking from admin/venue-calendar.html's "Send Invoice" action. Mirrors
// venue-booking-write.js's auth pattern exactly (same admin session token,
// same shared Supabase secret) but forwards to the venue-booking-invoice-create
// Supabase edge function instead.
//
// POST /.netlify/functions/venue-booking-invoice-create
// Body: { token, booking_id, label?, amount?, due_date? }
// ============================================================================
const crypto = require('crypto');

const SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const SESSION_TTL_HOURS = 168;
const VENUE_AVAILABILITY_KEY = process.env.VENUE_AVAILABILITY_KEY || '';
const SUPABASE_FN_URL = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/venue-booking-invoice-create';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  if (!VENUE_AVAILABILITY_KEY) return reply(503, { error: 'Venue booking invoicing is not configured on the server.' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return reply(400, { error: 'invalid_json' });
  }

  const { token, ...invoiceRequest } = payload;
  if (!verifyToken(token)) return reply(401, { error: 'unauthorized' });

  try {
    const r = await fetch(SUPABASE_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-key': VENUE_AVAILABILITY_KEY },
      body: JSON.stringify(invoiceRequest),
    });
    const body = await r.json();
    return reply(r.status, body);
  } catch (e) {
    return reply(500, { error: 'exception', message: e.message });
  }
};
