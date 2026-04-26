// ============================================================================
// marketing-send.js
//
// Two modes:
//
// (A) Cron poll — POST/GET with no body or { mode: 'poll' }
//     Looks at marketing_drafts.json for drafts where:
//        status === 'approved' AND scheduledFor <= now
//     Sends each via SendGrid, marks status='sent' (or 'failed'), saves back.
//
// (B) Send-now — POST { mode: 'sendNow', draftId: '<id>' }
//     Forces a single draft to send immediately, regardless of scheduledFor.
//     Marks the draft 'sent' on success.
//
// (C) Test — POST { mode: 'test', draftId: '<id>', testEmail: 'x@y.com' }
//     Sends a one-off test of the rendered draft to a single address.
//     Does NOT mutate the draft.
//
// Resolves recipients by calling /.netlify/functions/sendgrid-contacts (built
// alongside this) which queries SendGrid Contacts segments by name.
//
// Env: SENDGRID_API_KEY, QUARRY_DATA_KEY (optional auth gate)
// ============================================================================

const fetch = require('node-fetch');

const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const QUARRY_DATA_KEY = process.env.QUARRY_DATA_KEY || '';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-quarry-key',
    'Content-Type': 'application/json'
};
const respond = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// ----------------------------------------------------------------------------
// SendGrid helpers
// ----------------------------------------------------------------------------

async function sgSearchContacts(segment) {
    // Map our human segment names to SendGrid query expressions.
    // 'All' / 'Subscribed' is the default — everyone not in unsubscribe groups.
    // Wine Club / Golf / Event Attendees rely on contact custom fields/tags
    // managed in SendGrid; if not set up yet, they fall through to the full list.
    const q = (() => {
        if (!segment || segment === 'All' || segment === 'Subscribed') return null;
        // Use SendGrid's contact search syntax — assumes a custom field 'segment_tag'.
        return `CONTAINS(LOWER(segment_tag), '${segment.toLowerCase().replace(/'/g, "''")}')`;
    })();

    if (!q) {
        // Pull all contacts (paginated). For larger lists, prefer creating
        // a SendGrid List + sending list_ids; v3 mail/send takes list_ids in
        // personalizations only via the Marketing Campaigns API. For our scale
        // (low-thousands), iterating contacts is fine.
        const r = await fetch('https://api.sendgrid.com/v3/marketing/contacts/count', {
            headers: { 'Authorization': `Bearer ${SENDGRID_KEY}` }
        });
        if (!r.ok) throw new Error('Could not query SendGrid contacts count');
        // For "Subscribed" we use the v3 Marketing Campaigns SingleSend pattern
        // and pass the all-contacts list — but as we may not have a singleSendId,
        // we fall back to per-email sends below.
    }

    // Per-email send list. Cap at 10k to be safe.
    const out = [];
    let token = '';
    while (true) {
        const url = `https://api.sendgrid.com/v3/marketing/contacts${token ? `?page_token=${encodeURIComponent(token)}` : ''}`;
        const r = await fetch(url, { headers: { 'Authorization': `Bearer ${SENDGRID_KEY}` } });
        if (!r.ok) {
            const body = await r.text();
            throw new Error(`SendGrid contacts list failed: ${r.status} ${body.slice(0, 200)}`);
        }
        const data = await r.json();
        const contacts = data.result || [];
        for (const c of contacts) {
            if (!c.email) continue;
            // Apply segment filter client-side if needed
            if (q && c.custom_fields && c.custom_fields.segment_tag) {
                if (!String(c.custom_fields.segment_tag).toLowerCase().includes(segment.toLowerCase())) continue;
            }
            out.push({ email: c.email, firstName: c.first_name || '', lastName: c.last_name || '' });
            if (out.length >= 10000) break;
        }
        if (out.length >= 10000) break;
        if (data._metadata && data._metadata.next) {
            // SendGrid returns full URLs in next; extract page_token
            const u = new URL(data._metadata.next);
            token = u.searchParams.get('page_token') || '';
            if (!token) break;
        } else break;
    }
    return out;
}

function applyMergeTags(html, contact) {
    return (html || '')
        .replace(/\{firstName\}/g, contact.firstName || 'there')
        .replace(/\{lastName\}/g, contact.lastName || '')
        .replace(/\{email\}/g, encodeURIComponent(contact.email));
}

async function sgSend({ to, subject, html, fromEmail, fromName, replyTo, category, customArgs }) {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: { email: fromEmail, name: fromName },
            reply_to: { email: replyTo || fromEmail },
            personalizations: [{ to: [{ email: to.email, name: [to.firstName, to.lastName].filter(Boolean).join(' ') || undefined }] }],
            subject,
            content: [{ type: 'text/html', value: html }],
            categories: [category],
            custom_args: customArgs,
            tracking_settings: { click_tracking: { enable: true, enable_text: false }, open_tracking: { enable: true } },
            mail_settings: { sandbox_mode: { enable: false } }
        })
    });
    const messageId = r.headers.get('x-message-id') || null;
    if (!r.ok) {
        const body = await r.text();
        throw new Error(`SendGrid send failed: ${r.status} ${body.slice(0, 200)}`);
    }
    return { messageId };
}

// ----------------------------------------------------------------------------
// Data file helpers
// ----------------------------------------------------------------------------

async function loadJsonFile(file) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`);
    if (!r.ok) throw new Error(`load ${file}: ${r.status}`);
    const d = await r.json();
    return { data: d.decoded || {}, sha: d.sha };
}
async function saveJsonFile(file, json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-quarry-key': QUARRY_DATA_KEY },
        body: JSON.stringify({ json, sha, message })
    });
    if (!r.ok) throw new Error(`save ${file}: ${r.status}`);
    return r.json();
}

// ----------------------------------------------------------------------------
// Send a single draft to its segment
// ----------------------------------------------------------------------------

async function sendDraftToSegment(draft, settings) {
    const recipients = await sgSearchContacts(draft.segment || 'Subscribed');
    if (!recipients.length) throw new Error('no recipients matched segment ' + draft.segment);

    const fromEmail = settings.fromEmail;
    const fromName = settings.fromName || 'The Quarry STL';
    const replyTo = settings.replyTo || fromEmail;
    const category = ((settings.sendgrid && settings.sendgrid.categoryPrefix) || 'quarry-marketing') + ':' + (draft.type || 'manual');

    let firstMessageId = null;
    let sent = 0, failed = 0;
    const failures = [];

    // Send sequentially to keep rate limits sane.
    for (const c of recipients) {
        try {
            const html = applyMergeTags(draft.htmlBody, c);
            const subject = applyMergeTags(draft.subject, c);
            const r = await sgSend({
                to: c, subject, html, fromEmail, fromName, replyTo,
                category,
                customArgs: { draft_id: draft.id, rule_id: draft.ruleId || '', email: c.email }
            });
            if (!firstMessageId) firstMessageId = r.messageId;
            sent++;
        } catch (e) {
            failed++;
            failures.push({ email: c.email, err: e.message });
            if (failures.length > 10) break; // bail if SendGrid is having a moment
        }
    }
    return { sent, failed, failures, sgMessageId: firstMessageId, recipientCount: recipients.length };
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

// Schedule: see netlify.toml. Manual trigger from the admin UI also works.
exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (!SENDGRID_KEY) return respond(500, { error: 'SENDGRID_API_KEY not configured in Netlify env vars' });

    const isScheduled = (event.body && /"next_run"/.test(event.body)) ||
                        (event.headers && /netlify/i.test(event.headers['user-agent'] || ''));
    if (!isScheduled && QUARRY_DATA_KEY) {
        const provided = event.headers['x-quarry-key'] || event.headers['X-Quarry-Key'] || '';
        if (provided !== QUARRY_DATA_KEY) return respond(401, { error: 'Missing or invalid x-quarry-key header' });
    }

    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) {}
    const mode = body.mode || 'poll';

    try {
        const draftsRes = await loadJsonFile('marketing_drafts.json');
        const draftsFile = draftsRes.data;
        const drafts = Array.isArray(draftsFile.drafts) ? draftsFile.drafts : [];
        const settings = draftsFile.settings || {};

        // ---------- TEST MODE ----------
        if (mode === 'test') {
            const draft = drafts.find((d) => d.id === body.draftId);
            if (!draft) return respond(404, { error: 'draft not found' });
            if (!body.testEmail) return respond(400, { error: 'testEmail required' });
            const fakeContact = { email: body.testEmail, firstName: 'Friend', lastName: '' };
            const html = applyMergeTags(draft.htmlBody, fakeContact);
            const subject = '[TEST] ' + applyMergeTags(draft.subject, fakeContact);
            const r = await sgSend({
                to: fakeContact, subject, html,
                fromEmail: settings.fromEmail, fromName: settings.fromName, replyTo: settings.replyTo,
                category: 'quarry-marketing:test',
                customArgs: { draft_id: draft.id, test: 'true' }
            });
            return respond(200, { ok: true, mode: 'test', sgMessageId: r.messageId });
        }

        // ---------- POLL or SENDNOW ----------
        const now = Date.now();
        const queue = mode === 'sendNow'
            ? drafts.filter((d) => d.id === body.draftId && (d.status === 'approved' || d.status === 'pending'))
            : drafts.filter((d) => d.status === 'approved' && d.scheduledFor && new Date(d.scheduledFor).getTime() <= now);

        if (!queue.length) return respond(200, { ok: true, mode, sentCount: 0, message: 'nothing to send' });

        const results = [];
        let mutated = false;

        for (const draft of queue) {
            try {
                const r = await sendDraftToSegment(draft, settings);
                draft.status = 'sent';
                draft.sentAt = new Date().toISOString();
                draft.updatedAt = draft.sentAt;
                draft.sgMessageId = r.sgMessageId;
                draft.deliveryStats = { recipientCount: r.recipientCount, sent: r.sent, failed: r.failed };
                results.push({ id: draft.id, ok: true, ...r });
                mutated = true;
            } catch (err) {
                draft.status = 'failed';
                draft.updatedAt = new Date().toISOString();
                draft.failureReason = err.message;
                results.push({ id: draft.id, ok: false, error: err.message });
                mutated = true;
            }
        }

        if (mutated) {
            draftsFile.drafts = drafts;
            draftsFile.updatedAt = new Date().toISOString();
            await saveJsonFile('marketing_drafts.json', draftsFile, draftsRes.sha,
                `marketing-send: ${results.filter((r) => r.ok).length} sent, ${results.filter((r) => !r.ok).length} failed`);
        }

        return respond(200, { ok: true, mode, results, sentCount: results.filter((r) => r.ok).length });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
