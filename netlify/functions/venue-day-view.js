// ============================================================================
// venue-day-view.js
//
// Server-side proxy for the venue day-view calendar prototype (admin/venue-calendar.html).
// Guest contact details and booking data must never reach the public site
// unauthenticated (see BOOKINGS-SYSTEM.md's security note), so this function:
//   1. Requires the same admin session token used by admin/index.html
//      (verified with the identical HMAC scheme as verify-admin-password.js)
//   2. Holds the Supabase venue-availability shared secret (VENUE_AVAILABILITY_KEY)
//      server-side only — it is never sent to the browser.
//
// GET /.netlify/functions/venue-day-view?token=...&start=YYYY-MM-DD&days=N
// ============================================================================
const crypto = require('crypto');

const SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const SESSION_TTL_HOURS = 168;
const VENUE_AVAILABILITY_KEY = process.env.VENUE_AVAILABILITY_KEY || '';
const SUPABASE_FN_URL = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/venue-availability';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
  if (event.httpMethod !== 'GET') return reply(405, { error: 'GET only' });

  const q = event.queryStringParameters || {};
  if (!verifyToken(q.token)) return reply(401, { error: 'unauthorized' });
  if (!VENUE_AVAILABILITY_KEY) return reply(503, { error: 'Venue availability is not configured on the server.' });

  const start = (q.start || '').trim();
  const daysParam = parseInt(q.days || '1', 10);
  const days = Math.max(1, Math.min(31, isNaN(daysParam) ? 1 : daysParam));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return reply(400, { error: 'start must be YYYY-MM-DD' });

  try {
    const url = `${SUPABASE_FN_URL}?start=${encodeURIComponent(start)}&days=${days}`;
    const r = await fetch(url, { headers: { 'x-access-key': VENUE_AVAILABILITY_KEY } });
    const body = await r.json();
    return reply(r.status, body);
  } catch (e) {
    return reply(500, { error: 'exception', message: e.message });
  }
};
