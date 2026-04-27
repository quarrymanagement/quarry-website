// ============================================================================
// marketing-send.js  (v2 — Marketing Campaigns Single Sends)
//
// Modes:
//   (A) poll       — drains 'approved' drafts whose scheduledFor <= now.
//                    Creates a SendGrid Single Send for each, schedules it
//                    to send immediately (or at scheduledFor), records the
//                    Single Send ID on the draft for later stats polling.
//
//   (B) sendNow    — body { mode:'sendNow', draftId } — same as poll for
//                    a single draft, ignoring scheduledFor.
//
//   (C) test       — body { mode:'test', draftId, testEmail } — sends a
//                    one-off via /v3/mail/send (transactional API, no list).
//                    Subject auto-prefixed with [TEST].
//
// Why Single Sends?
//   - Counts against Marketing Campaigns quota (15k/mo on Basic 5k), not
//     the Email API daily 100-cap.
//   - Built-in tracking; stats pull-able via /v3/marketing/stats/singlesends.
//   - Suppression handled automatically (unsubscribed contacts skipped).
//   - Better deliverability via SendGrid's reputation-managed marketing IPs.
//
// Required env vars:
//   SENDGRID_API_KEY         restricted marketing key
//   SENDGRID_SENDER_ID       verified sender identity ID
//   SENDGRID_LIST_SUBSCRIBED list ID for Subscribed segment
//   SENDGRID_LIST_LEGACY     list ID for Wix Legacy segment
//   SENDGRID_LIST_ALL        list ID for combined ALL list
//   SENDGRID_UNSUB_GROUP_ID  unsubscribe group id (50859)
// ============================================================================

const fetch = require('node-fetch');

const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const SG_KEY   = process.env.SENDGRID_API_KEY;
const SENDER   = process.env.SENDGRID_SENDER_ID;
const LIST_ALL = process.env.SENDGRID_LIST_ALL;
const LIST_SUB = process.env.SENDGRID_LIST_SUBSCRIBED;
const LIST_LEG = process.env.SENDGRID_LIST_LEGACY;
const UNSUB_GROUP = parseInt(process.env.SENDGRID_UNSUB_GROUP_ID || '0', 10);
const QUARRY_DATA_KEY = process.env.QUARRY_DATA_KEY || '';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-quarry-key',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function htmlToPlainText(html) {
    if (!html) return '';
    return String(html)
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => `${text.replace(/<[^>]+>/g,'').trim()} (${url})`)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&middot;/gi, '·').replace(/&[a-z]+;/gi, '')
        .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function segmentToListIds(segment) {
    // Resolve a human segment name to one or more SendGrid list IDs.
    switch ((segment || 'Subscribed')) {
        case 'Subscribed':       return LIST_SUB ? [LIST_SUB] : (LIST_ALL ? [LIST_ALL] : []);
        case 'Wix Legacy':       return LIST_LEG ? [LIST_LEG] : [];
        case 'All':              return LIST_ALL ? [LIST_ALL] : [];
        case 'Wine Club':
        case 'Golf':
        case 'Event Attendees':
            // No dedicated list yet — fall back to ALL with a note. When you
            // create dedicated SG lists for these, add their IDs to env vars.
            return LIST_ALL ? [LIST_ALL] : [];
        default:
            return LIST_ALL ? [LIST_ALL] : [];
    }
}

async function loadDraftsFile() {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=marketing_drafts.json`);
    if (!r.ok) throw new Error('load drafts: ' + r.status);
    const d = await r.json();
    return { data: d.decoded || {}, sha: d.sha };
}
async function saveDraftsFile(json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=marketing_drafts.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json, sha, message })
    });
    if (!r.ok) throw new Error('save drafts: ' + r.status);
    return r.json();
}

// ----------------------------------------------------------------------------
// SendGrid: create + schedule a Single Send
// ----------------------------------------------------------------------------

async function createAndScheduleSingleSend(draft, listIds) {
    const plainText = htmlToPlainText(draft.htmlBody);
    const sendAt = (draft.scheduledFor && new Date(draft.scheduledFor).getTime() > Date.now())
        ? new Date(draft.scheduledFor).toISOString()
        : 'now';

    const ssBody = {
        name: `${draft.subject || 'Quarry campaign'} (${draft.id.slice(0, 8)})`,
        send_at: sendAt,
        send_to: { list_ids: listIds, all: false },
        email_config: {
            subject: draft.subject,
            html_content: draft.htmlBody,
            plain_content: plainText || ' ',
            generate_plain_content: false,
            sender_id: parseInt(SENDER, 10),
            // Use custom_unsubscribe_url instead of suppression_group_id so SendGrid
            // does NOT auto-inject the ugly blue "Unsubscribe from this list / manage
            // email preferences" footer block. Our /unsubscribe Netlify function
            // suppresses the contact in SendGrid global suppressions, so unsubs are
            // still honored and the user is still removed from future sends.
            custom_unsubscribe_url: 'https://www.thequarrystl.com/.netlify/functions/unsubscribe?email={email}'
        },
        categories: ['quarry-marketing', `type:${draft.type || 'manual'}`]
    };

    // Step 1: create the Single Send
    let r = await fetch('https://api.sendgrid.com/v3/marketing/singlesends', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(ssBody)
    });
    if (!r.ok) {
        const text = await r.text();
        throw new Error(`SS create failed (${r.status}): ${text.slice(0, 300)}`);
    }
    const created = await r.json();
    const sendId = created.id;

    // Step 2: schedule it (separate call per the SendGrid API design)
    r = await fetch(`https://api.sendgrid.com/v3/marketing/singlesends/${sendId}/schedule`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ send_at: sendAt })
    });
    if (!r.ok) {
        const text = await r.text();
        throw new Error(`SS schedule failed (${r.status}): ${text.slice(0, 300)}`);
    }
    const scheduled = await r.json();
    return { sendId, status: scheduled.status, sendAt };
}

// ----------------------------------------------------------------------------
// Test mode (single recipient, transactional /v3/mail/send)
// ----------------------------------------------------------------------------

function applyMergeTags(html, contact) {
    return (html || '')
        .replace(/\{firstName\}/g, contact.firstName || 'there')
        .replace(/\{lastName\}/g,  contact.lastName  || '')
        .replace(/\{email\}/g,     encodeURIComponent(contact.email));
}

async function sendTest(draft, testEmail) {
    const fakeContact = { email: testEmail, firstName: 'Friend', lastName: '' };
    const html  = applyMergeTags(draft.htmlBody, fakeContact);
    const plain = htmlToPlainText(html);
    const subject = '[TEST] ' + applyMergeTags(draft.subject, fakeContact);
    const payload = {
        from: { email: 'management@thequarrystl.com', name: 'The Quarry STL' },
        reply_to: { email: 'management@thequarrystl.com' },
        personalizations: [{ to: [{ email: testEmail }] }],
        subject,
        content: [
            { type: 'text/plain', value: plain || ' ' },
            { type: 'text/html',  value: html }
        ],
        categories: ['quarry-marketing:test'],
        custom_args: { draft_id: draft.id, test: 'true' },
        tracking_settings: {
            click_tracking: { enable: true, enable_text: false },
            open_tracking: { enable: true },
            // FULLY DISABLE subscription tracking — we provide our own branded
            // unsubscribe link in the footer using the [unsubscribe_url] tag
            // is NOT used; we put a real <a href> directly. SendGrid satisfies
            // CAN-SPAM via the List-Unsubscribe header (also added below).
            subscription_tracking: { enable: false }
        },
        // Add List-Unsubscribe header so Gmail/Apple Mail get one-click compliance
        // without us needing visible auto-injected SendGrid text.
        headers: {
            'List-Unsubscribe': `<https://www.thequarrystl.com/.netlify/functions/unsubscribe?email=${encodeURIComponent(to.email)}>, <mailto:management@thequarrystl.com?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
    };
    // No `asm` block — that triggers SendGrid's blue "Unsubscribe From This List / Manage Email Preferences" footer block.
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const messageId = r.headers.get('x-message-id') || null;
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`Test send failed (${r.status}): ${t.slice(0, 200)}`);
    }
    return { messageId };
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (!SG_KEY) return respond(500, { error: 'SENDGRID_API_KEY not configured' });
    if (!SENDER) return respond(500, { error: 'SENDGRID_SENDER_ID not configured' });

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
        const draftsRes = await loadDraftsFile();
        const file = draftsRes.data;
        const drafts = Array.isArray(file.drafts) ? file.drafts : [];

        // ---- TEST ----
        if (mode === 'test') {
            const draft = drafts.find((d) => d.id === body.draftId);
            if (!draft) return respond(404, { error: 'draft not found' });
            if (!body.testEmail) return respond(400, { error: 'testEmail required' });
            const r = await sendTest(draft, body.testEmail);
            return respond(200, { ok: true, mode: 'test', sgMessageId: r.messageId });
        }

        // ---- POLL or SENDNOW ----
        const now = Date.now();
        const queue = mode === 'sendNow'
            ? drafts.filter((d) => d.id === body.draftId && (d.status === 'approved' || d.status === 'pending'))
            : drafts.filter((d) => d.status === 'approved' && d.scheduledFor && new Date(d.scheduledFor).getTime() <= now);

        if (!queue.length) return respond(200, { ok: true, mode, sentCount: 0, message: 'nothing to send' });

        const results = [];
        let mutated = false;

        for (const draft of queue) {
            try {
                const listIds = segmentToListIds(draft.segment);
                if (!listIds.length) {
                    throw new Error(`no SendGrid list configured for segment "${draft.segment}"`);
                }
                const r = await createAndScheduleSingleSend(draft, listIds);
                draft.status = 'sent';
                draft.sentAt = new Date().toISOString();
                draft.updatedAt = draft.sentAt;
                draft.sgSingleSendId = r.sendId;
                draft.sgSingleSendStatus = r.status;
                results.push({ id: draft.id, ok: true, sendId: r.sendId, scheduledFor: r.sendAt });
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
            file.drafts = drafts;
            file.updatedAt = new Date().toISOString();
            await saveDraftsFile(file, draftsRes.sha,
                `marketing-send: ${results.filter((r) => r.ok).length} scheduled, ${results.filter((r) => !r.ok).length} failed`);
        }

        return respond(200, { ok: true, mode, results, sentCount: results.filter((r) => r.ok).length });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
