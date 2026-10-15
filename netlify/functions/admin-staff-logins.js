// ============================================================================
// admin-staff-logins.js — OWNER ONLY
//
// Lets the owner set / reset / remove the password for a restricted staff
// login from Admin > Staff Logins, so the password is typed once by the owner
// and never passes through anyone else. Passwords are stored salted (scrypt)
// in Netlify Blobs and are never returned by this function.
//
// Logins are checked by verify-admin-password.js (same single password field).
//
// POST (header x-admin-token: <owner token>)
//   { action: 'status' }                         -> { accounts: [{ username, label, role, set, updated }] }
//   { action: 'set', username, password }        -> { ok: true }
//   { action: 'remove', username }               -> { ok: true }
//
// Resetting or removing an account also ends any session it already has
// (verify-admin-password.js rejects tokens issued before `validAfter`).
// ============================================================================
const crypto = require('crypto');
const { readBlob, writeBlob } = require('./_blobs');

// Same owner-token derivation as verify-admin-password.js — keep in sync.
const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
    || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const SESSION_TTL_HOURS = 168;
const OWNER_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const PENNY_HASH = process.env.PENNY_PASSWORD_HASH || '';

const ACCOUNTS_BLOB = 'admin-staff/accounts';
// username -> { label, role }. Add a line here AND in verify-admin-password.js
// DYNAMIC_ACCOUNTS to create another owner-managed login.
const ACCOUNTS = {
    maya: { label: 'Maya White (server lead)', role: 'server_lead' },
};

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
    'Content-Type': 'application/json',
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (s, secret) => crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex');

function isOwnerToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !ADMIN_SECRET) return false;
    const [issued, sig] = parts;
    if (!/^\d+$/.test(issued) || !sig) return false;
    const want = Buffer.from(hmac(issued, ADMIN_SECRET));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
    return ((Date.now() - parseInt(issued, 10)) / 3600000) < SESSION_TTL_HOURS;
}
function scryptMatches(password, rec) {
    try {
        const got = crypto.scryptSync(String(password), Buffer.from(rec.salt, 'hex'), 32);
        const want = Buffer.from(rec.hash, 'hex');
        return got.length === want.length && crypto.timingSafeEqual(got, want);
    } catch (_) { return false; }
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { ok: false, error: 'POST only' });

    const h = event.headers || {};
    const token = h['x-admin-token'] || h['X-Admin-Token'] || '';
    if (!isOwnerToken(token)) return respond(401, { ok: false, error: 'Owner login required.' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { ok: false, error: 'Invalid JSON' }); }

    const accts = (await readBlob(ACCOUNTS_BLOB)) || {};

    if (body.action === 'status') {
        return respond(200, {
            ok: true,
            accounts: Object.keys(ACCOUNTS).map((u) => ({
                username: u, label: ACCOUNTS[u].label, role: ACCOUNTS[u].role,
                set: !!(accts[u] && accts[u].hash), updated: (accts[u] && accts[u].updated) || null,
            })),
        });
    }

    const username = String(body.username || '').toLowerCase();
    if (!ACCOUNTS[username]) return respond(400, { ok: false, error: 'Unknown login.' });

    if (body.action === 'set') {
        const password = typeof body.password === 'string' ? body.password.trim() : '';
        if (password.length < 8) return respond(400, { ok: false, error: 'Use at least 8 characters.' });
        if (password.length > 100) return respond(400, { ok: false, error: 'That password is too long.' });
        // One password must identify exactly one login: refuse a password that
        // already opens the owner login, Penny's, or another managed login.
        if ((OWNER_HASH && sha256(password) === OWNER_HASH) || (PENNY_HASH && sha256(password) === PENNY_HASH)) {
            return respond(400, { ok: false, error: "That password is already in use by another login. Pick a different one." });
        }
        for (const u of Object.keys(accts)) {
            if (u !== username && accts[u] && accts[u].hash && scryptMatches(password, accts[u])) {
                return respond(400, { ok: false, error: "That password is already in use by another login. Pick a different one." });
            }
        }
        const salt = crypto.randomBytes(16);
        const hash = crypto.scryptSync(password, salt, 32);
        const now = Date.now();
        accts[username] = { salt: salt.toString('hex'), hash: hash.toString('hex'), updated: new Date(now).toISOString(), validAfter: now };
        const ok = await writeBlob(ACCOUNTS_BLOB, accts);
        if (ok === false) return respond(500, { ok: false, error: 'Could not save. Try again.' });
        return respond(200, { ok: true });
    }

    if (body.action === 'remove') {
        delete accts[username];
        const ok = await writeBlob(ACCOUNTS_BLOB, accts);
        if (ok === false) return respond(500, { ok: false, error: 'Could not save. Try again.' });
        return respond(200, { ok: true });
    }

    return respond(400, { ok: false, error: 'Unknown action.' });
};
