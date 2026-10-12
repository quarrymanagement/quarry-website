// ============================================================================
// quarryfest-vendor-social.js
//
// Admin-only: ticks / unticks the "social post done" checkbox for a Quarry
// Fest vendor in the admin panel, so staff can track which vendors have been
// featured on social media. Only touches socialPosted / socialPostedAt --
// status, payment and emails are untouched.
//
// POST /.netlify/functions/quarryfest-vendor-social
// Body: { token, vendorId, posted: true|false }
// ============================================================================

const crypto = require('crypto');
const { readBlob, writeBlob } = require('./_blobs');

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

    const vendorId = String(body.vendorId || '').trim();
    if (!vendorId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'vendorId is required' }) };
    const posted = body.posted === true;

    const existing = (await readBlob(BOOKINGS_PATH)) || { vendors: [] };
    const vendors = existing.vendors || [];
    const idx = vendors.findIndex((v) => v.vendorId === vendorId);
    if (idx === -1) return { statusCode: 404, headers: CORS, body: JSON.stringify({ ok: false, error: 'vendor not found' }) };

    vendors[idx].socialPosted = posted;
    vendors[idx].socialPostedAt = posted ? new Date().toISOString() : null;
    await writeBlob(BOOKINGS_PATH, { ...existing, vendors });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, vendorId, socialPosted: posted }) };
  } catch (err) {
    console.error('quarryfest-vendor-social error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
