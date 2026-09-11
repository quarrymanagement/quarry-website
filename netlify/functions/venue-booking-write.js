// ============================================================================
// venue-booking-write.js
//
// Server-side proxy for creating, editing, or deleting an internal venue
// booking from admin/venue-calendar.html. Mirrors venue-day-view.js's auth
// pattern exactly (admin OR restricted-staff session token, same shared
// Supabase secret).
//
// POST /.netlify/functions/venue-booking-write
// Body: { token, ...booking fields (see supabase venue-booking-write function) }
//
// DELETE /.netlify/functions/venue-booking-write?token=<token>&id=<booking id>
// Permanently removes a booking (and its spaces/line items/payments, via
// cascade on the Supabase side). Refused for wedding-portal bookings, same
// as editing one here — see the Supabase function for why.
//
// On a successful NEW booking (not an edit), best-effort matches the
// contact_email/contact_phone against open reservation inquiries
// (list-reservation-inquiries.js) and auto-advances any match to "confirmed"
// via update-reservation-status.js — so adding someone to the Venue Calendar
// is enough to mark their original inquiry booked, without a manual step.
// This never blocks or fails the booking itself; matching runs after the
// booking response is already determined, wrapped in its own try/catch.
// ============================================================================
const crypto = require('crypto');

const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const STAFF_SECRET = process.env.STAFF_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168;
const ALLOWED_ROLES = ['owner', 'events_staff'];
const VENUE_AVAILABILITY_KEY = process.env.VENUE_AVAILABILITY_KEY || '';
const SUPABASE_FN_URL = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/venue-booking-write';
const SITE_URL = process.env.URL || 'https://thequarrystl.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
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

function normalizePhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// Best-effort: find any OPEN (not already confirmed/lost) reservation inquiry
// matching this booking's contact email/phone, and advance it to "confirmed".
// Never throws past its own boundary — a matching failure must never turn
// into a booking-creation failure.
async function matchAndConfirmInquiry(token, booking) {
  const email = (booking.contact_email || '').trim().toLowerCase();
  const phone = normalizePhone(booking.contact_phone);
  if (!email && !phone) return;

  const listRes = await fetch(`${SITE_URL}/.netlify/functions/list-reservation-inquiries?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
  if (!listRes.ok) return;
  const listBody = await listRes.json();
  if (!listBody.ok) return;

  const matches = (listBody.inquiries || []).filter((inq) => {
    if (['confirmed', 'lost'].includes(inq.status)) return false; // already settled
    const inqEmail = (inq.email || '').trim().toLowerCase();
    const inqPhone = normalizePhone(inq.phone);
    return (email && inqEmail && inqEmail === email) || (phone && inqPhone && inqPhone === phone);
  });

  for (const inq of matches) {
    await fetch(`${SITE_URL}/.netlify/functions/update-reservation-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token, submissionId: inq.id, status: 'confirmed',
        note: `Booked in Venue Calendar: "${booking.title || 'untitled event'}"`, by: 'admin',
      }),
    }).catch(() => {});
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (!VENUE_AVAILABILITY_KEY) return reply(503, { error: 'Venue booking write is not configured on the server.' });

  if (event.httpMethod === 'DELETE') {
    const q = event.queryStringParameters || {};
    const auth = verifyAnyToken(q.token);
    if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return reply(401, { error: 'unauthorized' });
    if (!q.id) return reply(400, { error: 'missing_id' });
    try {
      const r = await fetch(`${SUPABASE_FN_URL}?id=${encodeURIComponent(q.id)}`, {
        method: 'DELETE',
        headers: { 'x-access-key': VENUE_AVAILABILITY_KEY },
      });
      const body = await r.json();
      return reply(r.status, body);
    } catch (e) {
      return reply(500, { error: 'exception', message: e.message });
    }
  }

  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST or DELETE only' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return reply(400, { error: 'invalid_json' });
  }

  const { token, ...booking } = payload;
  const auth = verifyAnyToken(token);
  if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return reply(401, { error: 'unauthorized' });

  try {
    const r = await fetch(SUPABASE_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-key': VENUE_AVAILABILITY_KEY },
      body: JSON.stringify(booking),
    });
    const body = await r.json();

    // Only for a brand-new booking (not an edit) that actually succeeded.
    if (r.status === 201 && !booking.id) {
      try { await matchAndConfirmInquiry(token, booking); } catch (_) { /* best-effort */ }
    }

    return reply(r.status, body);
  } catch (e) {
    return reply(500, { error: 'exception', message: e.message });
  }
};
