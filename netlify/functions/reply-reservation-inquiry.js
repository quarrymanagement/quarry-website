// ============================================================================
// reply-reservation-inquiry.js
//
// Sends a tracked reply to a reservation inquiry FROM the admin panel itself
// (instead of the old mailto: link, which the server could never see) and,
// on a successful send, automatically advances that inquiry's status —
// this is the only reason the reply needs to go through the server at all:
// a mailto: link gives us zero signal that contact happened.
//
// POST /.netlify/functions/reply-reservation-inquiry
// Body: { token, submissionId, to, subject, body }
//   - token: admin session token (owner or events_staff — same dual scheme
//     as verify-admin-password.js)
//   - submissionId: the Netlify Forms submission id (same id
//     list-reservation-inquiries.js / update-reservation-status.js key on)
//   - to/subject/body: the reply itself. body is plain text; a simple HTML
//     version (line breaks -> <br>) is generated for the email.
//
// Auto-advance mapping (only ever moves an inquiry FORWARD, never backward):
//   not_contacted   -> contacted
//   needs_followup  -> contacted_2   ("Followed Up")
//   contacted       -> contacted_2
//   contacted_2 / confirmed / lost -> left unchanged (already further along,
//     or a reply here doesn't mean anything for a booking that's already
//     confirmed/lost)
// ============================================================================

const fetch = require('node-fetch');
const crypto = require('crypto');

const SITE_URL = process.env.URL || 'https://thequarrystl.com';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const FROM_EMAIL = 'management@thequarrystl.com';
const FROM_NAME = 'The Quarry';

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

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendReplyEmail(to, subject, plainBody, cc) {
    if (!SENDGRID_API_KEY) throw new Error('SENDGRID_API_KEY not configured on the server');
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;white-space:pre-wrap;">${escapeHtml(plainBody)}</div>`;
    const personalization = { to: [{ email: to }] };
    // cc: optional single address or array — e.g. looping in Jacqueline on a
    // wedding-inquiry handoff email so she's visible to the customer from the
    // first message, not just forwarded after the fact.
    if (cc) personalization.cc = (Array.isArray(cc) ? cc : [cc]).map((email) => ({ email }));
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            personalizations: [personalization],
            from: { email: FROM_EMAIL, name: FROM_NAME },
            subject,
            content: [
                { type: 'text/plain', value: plainBody },
                { type: 'text/html', value: html },
            ],
        }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`sendgrid_${res.status} ${text.slice(0, 300)}`);
    }
}

async function loadStatusFile() {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`);
    if (!r.ok) return { data: { overrides: {} }, sha: null };
    const d = await r.json();
    return { data: d.decoded || { overrides: {} }, sha: d.sha };
}
async function saveStatusFile(json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json, sha, message })
    });
    if (!r.ok) throw new Error(`save reservations_status.json: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
}

// Only ever advances forward — a reply never demotes a confirmed/lost inquiry,
// and never un-does a follow-up someone already logged.
const NEXT_STATUS = {
    not_contacted: 'contacted',
    needs_followup: 'contacted_2',
    contacted: 'contacted_2',
    responded: 'contacted_2',
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { ok: false, error: 'POST only' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { ok: false, error: 'Invalid JSON' }); }

    const auth = verifyAnyToken(body.token);
    if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return respond(401, { ok: false, error: 'unauthorized' });

    const { submissionId, to, subject, body: messageBody, cc } = body;
    if (!submissionId) return respond(400, { ok: false, error: 'submissionId required' });
    if (!to || !subject || !messageBody) return respond(400, { ok: false, error: 'to, subject, and body are required' });

    try {
        await sendReplyEmail(to, subject, messageBody, cc);
    } catch (err) {
        return respond(502, { ok: false, error: 'Could not send email: ' + err.message });
    }

    // The email is already sent at this point — a failure below (e.g. a
    // conflicting concurrent write) must never be reported back as "reply
    // failed", since it didn't. It just means the status auto-advance step
    // itself needs a retry, same as update-reservation-status.js's own writes.
    try {
        const { data, sha } = await loadStatusFile();
        data.overrides = data.overrides || {};
        const existing = data.overrides[submissionId] || {};
        const now = new Date().toISOString();
        const prevStatus = existing.status || 'not_contacted';
        const nextStatus = NEXT_STATUS[prevStatus] || prevStatus;
        const history = Array.isArray(existing.history) ? existing.history : [];
        if (nextStatus !== prevStatus) {
            history.push({ from: prevStatus, to: nextStatus, by: 'admin', note: `Replied: "${subject}"`, at: now });
        }
        data.overrides[submissionId] = {
            status: nextStatus,
            note: existing.note || '',
            updatedAt: now,
            updatedBy: 'admin',
            history
        };
        data.updatedAt = now;
        await saveStatusFile(data, sha, `reservations: ${submissionId.slice(0, 8)} replied → ${nextStatus}`);
        return respond(200, { ok: true, sentTo: to, override: data.overrides[submissionId] });
    } catch (err) {
        return respond(200, { ok: true, sentTo: to, warning: 'Reply sent, but could not update status: ' + err.message });
    }
};
