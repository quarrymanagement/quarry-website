// ============================================================================
// quarryfest-vendor-remove.js
//
// Admin-only: removes a single Quarry Fest vendor registration by vendorId.
// For clearing a test entry or a mistaken/duplicate signup. Does not issue
// a refund -- only removes the record.
//
// POST /.netlify/functions/quarryfest-vendor-remove
// Body: { token, vendorId }
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

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'invalid JSON' }) }; }

  const auth = verifyAnyToken(body.token);
  if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

  const vendorId = String(body.vendorId || '').trim();
  if (!vendorId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'vendorId is required' }) };

  try {
    const existing = (await readBlob(BOOKINGS_PATH)) || { vendors: [] };
    const before = (existing.vendors || []).length;
    const vendors = (existing.vendors || []).filter((v) => v.vendorId !== vendorId);
    await writeBlob(BOOKINGS_PATH, { vendors });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, removed: before - vendors.length, remaining: vendors.length }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(e.message || e) }) };
  }
};
