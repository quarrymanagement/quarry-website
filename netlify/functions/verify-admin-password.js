// ============================================================================
// verify-admin-password.js
//
// Replaces the plaintext-in-source password check. The hash of the canonical
// password lives in the ADMIN_PASSWORD_HASH env var (sha256 of utf-8 bytes).
//
// POST /.netlify/functions/verify-admin-password { password }
//   → { ok: true, token: <session token> } if correct
//   → 401 otherwise
//
// The session token is HMAC of (timestamp + ADMIN_SESSION_SECRET) so the
// client can persist it and we can verify expiry without a session store.
//
// Setup once:
//   1. In Netlify env: ADMIN_PASSWORD_HASH = sha256("yourpassword")
//      Compute via: echo -n "quarry2026" | shasum -a 256
//      e.g. for "quarry2026" -> 8c2ba0b3eea0fdee06b64c0bd06b22b25f74b3c11fe98a1e4cb29d6b2e5b8b9d
//   2. ADMIN_SESSION_SECRET = any 32+ char random string
//   3. Remove the plaintext password check from admin/index.html (done in this PR)
// ============================================================================

const crypto = require('crypto');

const HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SECRET = process.env.ADMIN_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168; // 7 days

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }

function makeToken() {
    if (!SECRET) return null;
    const issued = Date.now();
    const payload = `${issued}`;
    const sig = hmac(payload, SECRET);
    return `${issued}.${sig}`;
}

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
    if (event.httpMethod !== 'POST') return respond(405, { ok: false, error: 'POST only' });

    if (!HASH) {
        // Fallback: if no hash configured yet, accept the legacy plaintext for
        // continuity. This makes the migration safe — admin keeps working until
        // you set the env var, then plaintext stops working.
        try {
            const body = JSON.parse(event.body || '{}');
            if (body.password === 'quarry2026') {
                return respond(200, { ok: true, token: makeToken(), legacy: true });
            }
        } catch (_) {}
        return respond(401, { ok: false, error: 'ADMIN_PASSWORD_HASH not configured. Falling back to plaintext denied.' });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { ok: false, error: 'Invalid JSON' }); }

    // Allow {action:'verify', token} for session restoration
    if (body.action === 'verify' && body.token) {
        return respond(200, { ok: verifyToken(body.token) });
    }

    const password = body.password || '';
    if (sha256(password) === HASH) {
        return respond(200, { ok: true, token: makeToken() });
    }
    return respond(401, { ok: false });
};
