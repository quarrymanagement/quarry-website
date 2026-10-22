// ============================================================================
// _admin-auth.js — shared admin/staff session-token check (import-only).
//
// Same token scheme and secret derivation as save-events.js and
// verify-admin-password.js (keep the three in sync):
//   owner token  "<issuedMs>.<hmac(issuedMs, SESSION_SECRET)>"
//   staff token  "<issuedMs>.<role>.<hmac(issuedMs.role, STAFF_SECRET)>"
// Token comes from the x-admin-token header, ?token= or body.adminToken/token.
// ============================================================================
const crypto = require('crypto');

const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const STAFF_SECRET = process.env.STAFF_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168;

function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }
function constantTimeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function suppliedToken(event, body) {
  const h = (event && event.headers) || {};
  const q = (event && event.queryStringParameters) || {};
  return h['x-admin-token'] || h['X-Admin-Token'] || q.token || (body && (body.adminToken || body.token)) || '';
}

// allowedStaffRoles: [] = owner only.
function verifyToken(token, allowedStaffRoles) {
  const parts = String(token || '').split('.');
  if (parts.length === 2) {
    const [issued, sig] = parts;
    if (!SESSION_SECRET || !/^\d+$/.test(issued)) return false;
    if (!constantTimeEq(hmac(issued, SESSION_SECRET), sig)) return false;
    return (Date.now() - parseInt(issued, 10)) / 3.6e6 < SESSION_TTL_HOURS;
  }
  if (parts.length === 3) {
    const [issued, role, sig] = parts;
    if (!STAFF_SECRET || !/^\d+$/.test(issued) || !(allowedStaffRoles || []).includes(role)) return false;
    if (!constantTimeEq(hmac(issued + '.' + role, STAFF_SECRET), sig)) return false;
    return (Date.now() - parseInt(issued, 10)) / 3.6e6 < SESSION_TTL_HOURS;
  }
  return false;
}

function isAuthorized(event, body, allowedStaffRoles) {
  return verifyToken(suppliedToken(event, body), allowedStaffRoles);
}

module.exports = { isAuthorized, verifyToken, suppliedToken };
