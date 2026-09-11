// ============================================================================
// update-reservation-status.js
//
// POST /.netlify/functions/update-reservation-status
// body: { token, submissionId, status, note?, by? }
//
// Persists a manual status change for a reservation inquiry to
// reservations_status.json. The list endpoint merges these overrides on read.
//
// AUTH: requires an admin OR restricted-staff session token (same dual scheme
// as verify-admin-password.js) — previously this endpoint had no auth at all.
//
// Status values: not_contacted | contacted | needs_followup | contacted_2 | responded | sent_to_jacqueline | confirmed | lost
// ============================================================================

const fetch = require('node-fetch');
const crypto = require('crypto');

const SITE_URL = process.env.URL || 'https://thequarrystl.com';

const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
    || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const STAFF_SECRET = process.env.STAFF_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168;
const ALLOWED_ROLES = ['owner', 'events_staff'];

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

const VALID_STATUSES = new Set([
    'not_contacted', 'contacted', 'needs_followup',
    'contacted_2', 'responded', 'sent_to_jacqueline', 'confirmed', 'lost'
]);

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

async function loadFile() {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`);
    if (!r.ok) {
        // File may not exist yet — fall through to empty payload
        return { data: { overrides: {} }, sha: null };
    }
    const d = await r.json();
    return { data: d.decoded || { overrides: {} }, sha: d.sha };
}
async function saveFile(json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json, sha, message })
    });
    if (!r.ok) throw new Error(`save reservations_status.json: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { ok: false, error: 'POST only' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { ok: false, error: 'Invalid JSON' }); }

    const auth = verifyAnyToken(body.token);
    if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return respond(401, { ok: false, error: 'unauthorized' });

    // hidden: true/false is a separate axis from status — it's how a duplicate
    // or junk inquiry gets removed from the admin's list without touching
    // (or destroying the record of) its actual contact status. Either field
    // can be sent alone; at least one is required.
    const { submissionId, status, note, by, hidden } = body;
    if (!submissionId) return respond(400, { ok: false, error: 'submissionId required' });
    if (status !== undefined && !VALID_STATUSES.has(status)) {
        return respond(400, { ok: false, error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
    }
    if (status === undefined && hidden === undefined) {
        return respond(400, { ok: false, error: 'status or hidden required' });
    }

    try {
        const { data, sha } = await loadFile();
        data.overrides = data.overrides || {};
        const existing = data.overrides[submissionId] || {};
        const now = new Date().toISOString();
        const prevStatus = existing.status || 'not_contacted';
        const nextStatus = status !== undefined ? status : prevStatus;
        const history = Array.isArray(existing.history) ? existing.history : [];
        if (status !== undefined && prevStatus !== nextStatus) {
            history.push({ from: prevStatus, to: nextStatus, by: by || 'admin', note: note || '', at: now });
        }
        if (hidden !== undefined) {
            history.push({ from: existing.hidden ? 'hidden' : 'visible', to: hidden ? 'hidden' : 'visible', by: by || 'admin', note: note || '', at: now });
        }
        data.overrides[submissionId] = {
            status: nextStatus,
            note: note !== undefined ? note : (existing.note || ''),
            updatedAt: now,
            updatedBy: by || 'admin',
            history,
            hidden: hidden !== undefined ? !!hidden : !!existing.hidden,
        };
        data.updatedAt = now;
        const summary = hidden !== undefined ? (hidden ? 'hidden' : 'unhidden') : nextStatus;
        await saveFile(data, sha, `reservations: ${submissionId.slice(0, 8)} → ${summary}`);
        return respond(200, { ok: true, submissionId, status: nextStatus, override: data.overrides[submissionId] });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
