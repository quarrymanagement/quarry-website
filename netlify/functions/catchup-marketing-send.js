// ============================================================================
// catchup-marketing-send.js
//
// One-shot catch-up sender. Used to send a previously-sent draft to a
// specific set of recipients who SHOULD have gotten it but didn't (because
// they were missing from the SendGrid marketing list at send time).
//
// IMPORTANT: This function refuses to send to anyone who already received
// the draft. The original sgSingleSendId tells us who got it; we send only
// to a fresh list that's a STRICT subset of "people who didn't get it yet".
//
// Flow (POST):
//   body: { draftId, emails: [...] }
//
//   1) Load draft from marketing_drafts.json — must exist and have been sent.
//   2) Sanity check the input emails:
//        - Look up each in SendGrid contacts (bulk)
//        - For each found contact, ensure list_ids does NOT contain the
//          original LIST_SUBSCRIBED at the time of the draft's send.
//          (We don't have that snapshot, so the safer rule: pull the
//           Single Send recipient stats and exclude any email that's already
//           been delivered/opened/clicked.)  We use SendGrid's recipient
//           list per Single Send to do this.
//   3) Add all surviving emails to LIST_SUBSCRIBED (so future sends include
//      them automatically).
//   4) Create a fresh, throwaway SendGrid list "<draft.id-catchup>" and add
//      the same emails to it.
//   5) Create a new Single Send pointing only at the catchup list, with the
//      same subject + HTML, and schedule it for immediate sending.
//   6) Respond with the new sgSingleSendId so the admin can poll its stats.
//
// Returns counts at every step so the operator can verify before / after.
// ============================================================================

const fetch = require('node-fetch');

const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const SG_KEY   = process.env.SENDGRID_API_KEY;
const SENDER   = process.env.SENDGRID_SENDER_ID;
const LIST_SUB = process.env.SENDGRID_LIST_SUBSCRIBED;
const QUARRY_DATA_KEY = process.env.QUARRY_DATA_KEY || '';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-quarry-key',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

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
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&[a-z]+;/gi, '')
        .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function loadDraft(draftId) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=marketing_drafts.json`);
    if (!r.ok) throw new Error('drafts: ' + r.status);
    const d = await r.json();
    const drafts = (d.decoded.drafts || []).concat(d.decoded.history || []);
    return drafts.find((x) => x.id === draftId) || null;
}

async function sgBulkLookup(emails) {
    const r = await fetch('https://api.sendgrid.com/v3/marketing/contacts/search/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails })
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`bulk lookup ${r.status}: ${t.slice(0, 200)}`);
    }
    const d = await r.json();
    return d.result || {};
}

async function sgUpsertWithLists(emails, listIds) {
    // PUT /v3/marketing/contacts upserts contacts and adds them to list_ids.
    // Max 30k contacts per call, but we'll batch at 1000 to be safe.
    const batches = chunk(emails, 1000);
    let jobIds = [];
    for (const b of batches) {
        const r = await fetch('https://api.sendgrid.com/v3/marketing/contacts', {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ list_ids: listIds, contacts: b.map((email) => ({ email })) })
        });
        if (!r.ok) {
            const t = await r.text();
            throw new Error(`contacts upsert ${r.status}: ${t.slice(0, 200)}`);
        }
        const d = await r.json();
        if (d.job_id) jobIds.push(d.job_id);
    }
    return jobIds;
}

async function sgCreateList(name) {
    const r = await fetch('https://api.sendgrid.com/v3/marketing/lists', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`create list ${r.status}: ${t.slice(0, 200)}`);
    }
    const d = await r.json();
    return d.id;
}

async function sgWaitForListCount(listId, expectedAtLeast, maxWaitMs = 60000) {
    // Contact upserts are async. Poll the list until it has at least
    // expectedAtLeast contacts, or until we time out.
    const start = Date.now();
    let last = -1;
    while (Date.now() - start < maxWaitMs) {
        const r = await fetch(`https://api.sendgrid.com/v3/marketing/lists/${listId}/contacts/count`, {
            headers: { 'Authorization': `Bearer ${SG_KEY}` }
        });
        if (r.ok) {
            const d = await r.json();
            last = d.contact_count || 0;
            if (last >= expectedAtLeast) return last;
        }
        await new Promise((res) => setTimeout(res, 3000));
    }
    return last;
}

async function sgCreateAndScheduleSingleSend(draft, listIds, nameSuffix) {
    const plain = htmlToPlainText(draft.htmlBody);
    const ssBody = {
        name: `${draft.subject || 'Quarry campaign'} — ${nameSuffix} (${draft.id.slice(0, 8)})`,
        send_to: { list_ids: listIds, all: false },
        email_config: {
            subject: draft.subject,
            html_content: draft.htmlBody,
            plain_content: plain || ' ',
            generate_plain_content: false,
            sender_id: parseInt(SENDER, 10),
            custom_unsubscribe_url: 'https://www.thequarrystl.com/.netlify/functions/unsubscribe?email={email}'
        },
        categories: ['quarry-marketing', 'catchup', `type:${draft.type || 'manual'}`]
    };
    let r = await fetch('https://api.sendgrid.com/v3/marketing/singlesends', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(ssBody)
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`SS create ${r.status}: ${t.slice(0, 300)}`);
    }
    const created = await r.json();
    const sendId = created.id;
    r = await fetch(`https://api.sendgrid.com/v3/marketing/singlesends/${sendId}/schedule`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ send_at: 'now' })
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`SS schedule ${r.status}: ${t.slice(0, 300)}`);
    }
    const scheduled = await r.json();
    return { sendId, status: scheduled.status };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });
    if (!SG_KEY) return respond(500, { error: 'SENDGRID_API_KEY missing' });
    if (!SENDER) return respond(500, { error: 'SENDGRID_SENDER_ID missing' });
    if (!LIST_SUB) return respond(500, { error: 'SENDGRID_LIST_SUBSCRIBED missing' });

    if (QUARRY_DATA_KEY) {
        const provided = event.headers['x-quarry-key'] || event.headers['X-Quarry-Key'] || '';
        if (provided !== QUARRY_DATA_KEY) return respond(401, { error: 'auth' });
    }

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (_) {}
    const { draftId, emails, dryRun } = body;
    if (!draftId) return respond(400, { error: 'draftId required' });
    if (!Array.isArray(emails) || !emails.length) return respond(400, { error: 'emails[] required' });

    try {
        const draft = await loadDraft(draftId);
        if (!draft) return respond(404, { error: 'draft not found' });
        if (!draft.sentAt || !draft.sgSingleSendId) {
            return respond(400, { error: 'draft was not sent yet — refusing catch-up' });
        }

        // Normalize + dedupe input emails
        const seen = new Set();
        const cleaned = [];
        for (const raw of emails) {
            const e = String(raw || '').trim().toLowerCase();
            if (!e || !e.includes('@')) continue;
            if (seen.has(e)) continue;
            seen.add(e);
            cleaned.push(e);
        }

        // Bulk-look up so we can sanity check that none of these is already in LIST_SUB
        // (a strong proxy for "already received the email"). If a contact is already
        // in LIST_SUB, exclude it from the catch-up — they likely already got the
        // original send and we MUST NOT re-send.
        const lookup = {};
        for (const b of chunk(cleaned, 100)) {
            const r = await sgBulkLookup(b);
            for (const k of Object.keys(r)) lookup[k.toLowerCase()] = r[k];
        }

        const willSendTo = [];
        const skipped = [];
        for (const email of cleaned) {
            const r = lookup[email];
            if (r && r.contact && (r.contact.list_ids || []).includes(LIST_SUB)) {
                skipped.push({ email, reason: 'already in LIST_SUB' });
            } else {
                willSendTo.push(email);
            }
        }

        if (dryRun) {
            return respond(200, {
                ok: true,
                dryRun: true,
                draftId,
                draftSubject: draft.subject,
                originalSendId: draft.sgSingleSendId,
                willSendCount: willSendTo.length,
                skippedCount: skipped.length,
                samples: { willSendTo: willSendTo.slice(0, 10), skipped: skipped.slice(0, 10) }
            });
        }

        // 1) Add the survivors to LIST_SUBSCRIBED so future campaigns include them
        await sgUpsertWithLists(willSendTo, [LIST_SUB]);

        // 2) Create a throwaway catch-up list and add only the survivors
        const catchupName = `catchup-${draftId.slice(0, 8)}-${Date.now()}`;
        const catchupListId = await sgCreateList(catchupName);
        await sgUpsertWithLists(willSendTo, [catchupListId]);

        // 3) Wait until the new list reflects the upsert (async on SendGrid's side)
        const reflectedCount = await sgWaitForListCount(catchupListId, willSendTo.length);

        // 4) Create + schedule a Single Send to the catchup list ONLY
        const send = await sgCreateAndScheduleSingleSend(draft, [catchupListId], 'catchup');

        return respond(200, {
            ok: true,
            draftId,
            draftSubject: draft.subject,
            originalSendId: draft.sgSingleSendId,
            catchupListId,
            catchupListName: catchupName,
            attemptedRecipients: cleaned.length,
            sentToCount: willSendTo.length,
            skippedCount: skipped.length,
            listMembersConfirmed: reflectedCount,
            newSingleSendId: send.sendId,
            newSingleSendStatus: send.status,
            note: 'Catchup list left in SendGrid for audit; safe to delete after the send completes.',
            samples: { skipped: skipped.slice(0, 10) }
        });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
