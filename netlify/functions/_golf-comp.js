// ============================================================================
// _golf-comp.js  (helper, not an endpoint)
//
// Server-side gate for staff/admin comps (100% off). There is deliberately
// NO hardcoded comp code anywhere in the repo: the code lives only in a
// Netlify environment variable. If the variable is unset (or too short),
// comps are disabled and every request pays full price.
//
//   GOLF_ADMIN_COMP_CODE   - golf bay comps (square-checkout.js)
//   EVENT_ADMIN_COMP_CODE  - event ticket comps (event-register.js)
//
// Comparison is constant-time (SHA-256 both sides, then timingSafeEqual) so
// response timing does not leak how much of a guess matched.
// ============================================================================
const crypto = require('crypto');

const MIN_SECRET_LEN = 12;

function digest(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest();
}

function isAdminComp(code, envName) {
  const secret = process.env[envName || 'GOLF_ADMIN_COMP_CODE'];
  if (!secret || String(secret).trim().length < MIN_SECRET_LEN) return false;
  if (code === undefined || code === null || String(code).trim() === '') return false;
  return crypto.timingSafeEqual(digest(String(code).trim()), digest(String(secret).trim()));
}

module.exports = { isAdminComp, MIN_SECRET_LEN };
