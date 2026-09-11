// ============================================================================
// verify-admin-password.js
//
// Login for BOTH the full admin (owner) account and restricted staff accounts
// (e.g. Penny, events-only access). Same single password field client-side —
// this function tries the owner hash first, then each staff account, and
// mints a token in the matching format so downstream functions can tell the
// two apart without a shared session store.
//
// POST /.netlify/functions/verify-admin-password { password }
//   → { ok: true, token, role: 'owner' | 'events_staff' } if correct
//   → 401 otherwise
// POST /.netlify/functions/verify-admin-password { action: 'verify', token }
//   → { ok: boolean, role } — used to restore a session without re-prompting
//
// Two token shapes, both HMAC-based (no session store needed):
//   Owner:        "<issued>.<sig>"            sig = hmac(issued, ADMIN_SESSION_SECRET)
//   Staff/role:   "<issued>.<role>.<sig>"      sig = hmac(issued+'.'+role, STAFF_SESSION_SECRET)
// The role rides inside the signed payload for staff tokens, so it can't be
// tampered with client-side to claim a different role. A staff token can
// never verify as an owner token (different secret, different shape), and
// vice versa — the two are fully independent credentials.
//
// Setup:
//   ADMIN_PASSWORD_HASH   = sha256 of the owner's password
//   ADMIN_SESSION_SECRET  = any 32+ char random string (owner tokens)
//   STAFF_SESSION_SECRET  = any 32+ char random string (staff tokens) — must
//                           differ from ADMIN_SESSION_SECRET
//   PENNY_PASSWORD_HASH   = sha256 of Penny's password (role: events_staff)
//   Compute a hash via: echo -n "<password>" | shasum -a 256
//   (Never commit a password or its hash to this repo — it is public.)
//
// To add another restricted staff login later: add its own
// "<NAME>_PASSWORD_HASH" env var and one entry to STAFF_ACCOUNTS below.
// ============================================================================

const crypto = require('crypto');

const HASH = process.env.ADMIN_PASSWORD_HASH || '';
// Owner session-token secret. Prefer env var, but if it's not set we derive a
// stable fallback from GITHUB_TOKEN (which is always set) so tokens still
// mint. This is HMAC; tokens cannot be forged without the value.
const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
    || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
// Staff session-token secret — intentionally separate from ADMIN_SECRET so a
// leaked/guessed staff token can never verify as (or be upgraded to) an owner
// token. No env var means restricted logins are simply disabled.
const STAFF_SECRET = process.env.STAFF_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168; // 7 days

// Restricted staff accounts. `role` is what admin/index.html and the backing
// Netlify functions use to decide what's visible/allowed — see e.g.
// venue-day-view.js's ALLOWED_ROLES.
const STAFF_ACCOUNTS = [
    { username: 'penny', passwordHash: process.env.PENNY_PASSWORD_HASH || '', role: 'events_staff' },
];

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }

function makeOwnerToken() {
    if (!ADMIN_SECRET) return null;
    const issued = Date.now();
    return `${issued}.${hmac(String(issued), ADMIN_SECRET)}`;
}

function makeStaffToken(role) {
    if (!STAFF_SECRET) return null;
    const issued = Date.now();
    const payload = `${issued}.${role}`;
    return `${issued}.${role}.${hmac(payload, STAFF_SECRET)}`;
}

// Verifies either token shape. Returns { ok, role } — role is 'owner' for an
// owner token, or the staff role string for a staff token.
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
    if (event.httpMethod !== 'POST') return respond(405, { ok: false, error: 'POST only' });

    if (!HASH) {
        // No hash configured means admin auth is not set up. Fail closed. The
        // old plaintext fallback was removed 2026-08-03 — it was the last copy
        // of the password living in source, and this repo is public.
        return respond(503, { ok: false, error: 'Admin login is not configured on the server.' });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { ok: false, error: 'Invalid JSON' }); }

    // Allow {action:'verify', token} for session restoration
    if (body.action === 'verify' && body.token) {
        const result = verifyAnyToken(body.token);
        return respond(200, { ok: result.ok, role: result.role || null });
    }

    const password = body.password || '';

    if (sha256(password) === HASH) {
        return respond(200, { ok: true, token: makeOwnerToken(), role: 'owner' });
    }

    for (const acct of STAFF_ACCOUNTS) {
        if (acct.passwordHash && sha256(password) === acct.passwordHash) {
            const token = makeStaffToken(acct.role);
            if (!token) break; // STAFF_SESSION_SECRET not configured
            return respond(200, { ok: true, token, role: acct.role });
        }
    }

    return respond(401, { ok: false });
};
