// ============================================================================
// list-food-truck-bookings.js
//
// Admin-only: returns all food truck bookings within a date range. Blob
// storage (food-truck-bookings/{date}) is the sole source of truth -- every
// booking (pending or paid) is written there directly by food-truck-invite.js
// / square-webhook.js, so there's nothing else to reconcile against.
//
// GET /.netlify/functions/list-food-truck-bookings?token=...&startDate=...&endDate=...
// Returns: { ok: true, bookings: [...] }
// ============================================================================

const crypto = require('crypto');
const { readBlob } = require('./_blobs');

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

function todayStrCT() {
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return ct.getFullYear() + '-' + String(ct.getMonth() + 1).padStart(2, '0') + '-' + String(ct.getDate()).padStart(2, '0');
}
function addDays(yyyymmdd, n) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'GET only' }) };

  const q = event.queryStringParameters || {};
  const auth = verifyAnyToken(q.token);
  if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

  const startDate = q.startDate || todayStrCT();
  const endDate = q.endDate || addDays(startDate, 90);

  const all = [];
  let cursor = startDate;
  let dayCount = 0;
  while (cursor <= endDate && dayCount < 365) {
    try {
      const data = await readBlob('food-truck-bookings/' + cursor);
      if (data) {
        for (const b of (data.bookings || [])) all.push(b);
      }
    } catch (_) { /* skip days that error */ }
    cursor = addDays(cursor, 1);
    dayCount++;
  }

  all.sort((a, b) => {
    const k1 = (a.date || '') + ' ' + (a.time || '');
    const k2 = (b.date || '') + ' ' + (b.time || '');
    return k1.localeCompare(k2);
  });

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, range: { startDate, endDate }, count: all.length, bookings: all }) };
};
