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
// SENDING: goes out through the real management@thequarrystl.com Gmail
// account via the Gmail API (GMAIL_REFRESH_TOKEN_SEND — a broader-scoped
// token than the read-only GMAIL_REFRESH_TOKEN used elsewhere for search),
// not SendGrid. This used to go through SendGrid, which delivered the email
// fine but never touched Gmail at all — so the reply never showed up in
// "Email history" (gmail-threads.js searches the real mailbox) and never
// appeared as part of the same conversation in the recipient's inbox. Gmail
// send fixes both: the message lands in the account's own Sent mail (so
// history search finds it), and when an existing thread with this contact
// is found, the reply is attached to that thread with proper
// In-Reply-To/References headers so mail clients (Gmail, Outlook, Apple
// Mail) thread it together with the original conversation.
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
const { google } = require('googleapis');

const SITE_URL = process.env.URL || 'https://thequarrystl.com';
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

function gmailClient() {
    const oauth2Client = new google.auth.OAuth2(
        process.env.GMAIL_CLIENT_ID,
        process.env.GMAIL_CLIENT_SECRET,
        'https://developers.google.com/oauthplayground'
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN_SEND });
    return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Looks up the most recent message with this contact so a reply can be
// attached to that same Gmail thread (In-Reply-To/References + threadId) —
// mirrors gmail-threads.js's own search, but only needs the single latest
// message's headers, not the full multi-thread summary that endpoint builds.
async function findLatestMessage(gmail, contactEmail) {
    const list = await gmail.users.messages.list({
        userId: 'me',
        q: `from:${contactEmail} OR to:${contactEmail}`,
        maxResults: 1,
    });
    const msg = (list.data.messages || [])[0];
    if (!msg) return null;
    const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['Message-ID', 'References'],
    });
    const headers = detail.data.payload?.headers || [];
    const getHeader = (name) => (headers.find((h) => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';
    return {
        threadId: detail.data.threadId,
        messageId: getHeader('Message-ID'),
        references: getHeader('References'),
    };
}

function base64url(str) {
    return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendReplyEmail(to, subject, plainBody, cc) {
    const gmail = gmailClient();
    const prior = await findLatestMessage(gmail, to);

    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;white-space:pre-wrap;">${escapeHtml(plainBody)}</div>`;
    const boundary = 'quarry_' + crypto.randomBytes(12).toString('hex');
    const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : [];

    const headerLines = [
        `From: ${FROM_NAME} <${FROM_EMAIL}>`,
        `To: ${to}`,
        ccList.length ? `Cc: ${ccList.join(', ')}` : null,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];
    if (prior?.messageId) {
        // Threading only works if we can reference the actual prior Message-ID —
        // a missing/blank header (some senders omit it) means we fall back to
        // a fresh, unthreaded message rather than send malformed headers.
        headerLines.push(`In-Reply-To: ${prior.messageId}`);
        headerLines.push(`References: ${(prior.references ? prior.references + ' ' : '') + prior.messageId}`.trim());
    }

    const raw = [
        ...headerLines.filter(Boolean),
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        '',
        plainBody,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        '',
        html,
        '',
        `--${boundary}--`,
    ].join('\r\n');

    try {
        await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: base64url(raw),
                threadId: prior?.threadId || undefined,
            },
        });
    } catch (err) {
        const detail = err?.response?.data?.error?.message || err.message;
        throw new Error(`gmail_send_failed: ${detail}`);
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
