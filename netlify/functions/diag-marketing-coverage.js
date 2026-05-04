// ============================================================================
// diag-marketing-coverage.js
//
// Diagnostic ONLY — does NOT send anything.
//
// Compares subscribers.json (status='Subscribed') against the actual contents
// of the SendGrid LIST_SUBSCRIBED list, so we can see exactly who's marked as
// subscribed in our CRM but is NOT in the SendGrid list that marketing sends
// go to. This is the gap that explains why a campaign reaches fewer people
// than the CRM's Subscribed count suggests.
//
// Method:
//   1) Load subscribers.json from data-store.
//   2) Take all entries where emailStatus === 'Subscribed' AND email is set.
//   3) Bulk-look-up those emails in SendGrid via
//      POST /v3/marketing/contacts/search/emails (max 100/req, batched).
//   4) For each email, classify:
//        - notInSendGrid : doesn't exist as a contact in SG at all
//        - inSGNotInList : contact exists but isn't in LIST_SUBSCRIBED
//        - inListSub     : contact is in LIST_SUBSCRIBED (got the email,
//                          assuming not globally suppressed)
//   5) Also pull global suppression/bounce/block/spam lists so we can mark
//      contacts that ARE in the list but were suppressed at send time.
//
// Returns a JSON summary plus the lists of emails per bucket so the next
// step (re-sync the missing ones to LIST_SUB) can be done deliberately.
// ============================================================================

const fetch = require('node-fetch');

const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const SG_KEY = process.env.SENDGRID_API_KEY;
const LIST_SUB = process.env.SENDGRID_LIST_SUBSCRIBED;
const QUARRY_DATA_KEY = process.env.QUARRY_DATA_KEY || '';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-quarry-key',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

async function loadSubscribers() {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=subscribers.json`);
    if (!r.ok) throw new Error('subscribers.json: ' + r.status);
    const d = await r.json();
    return Array.isArray(d.decoded) ? d.decoded : [];
}

async function sgBulkLookup(emails) {
    // Returns map { email: { contact|null, error } } for up to 100 emails.
    const r = await fetch('https://api.sendgrid.com/v3/marketing/contacts/search/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails })
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`SG bulk lookup ${r.status}: ${t.slice(0, 200)}`);
    }
    const data = await r.json();
    return data.result || {};
}

async function loadSuppressionList(path) {
    // Pages through up to ~5000 entries. SendGrid returns plain array of {email,...}.
    const out = [];
    let offset = 0;
    const limit = 500;
    while (true) {
        const r = await fetch(`https://api.sendgrid.com/v3/suppression/${path}?limit=${limit}&offset=${offset}`, {
            headers: { 'Authorization': `Bearer ${SG_KEY}` }
        });
        if (!r.ok) {
            const t = await r.text();
            throw new Error(`suppression/${path} ${r.status}: ${t.slice(0, 200)}`);
        }
        const arr = await r.json();
        if (!Array.isArray(arr) || !arr.length) break;
        for (const row of arr) if (row && row.email) out.push(String(row.email).toLowerCase());
        if (arr.length < limit) break;
        offset += limit;
        if (offset > 20000) break; // hard safety
    }
    return out;
}

async function loadGlobalUnsubs() {
    // /v3/asm/suppressions/global is the global unsubscribe list (separate path).
    const out = [];
    let offset = 0;
    const limit = 500;
    while (true) {
        const r = await fetch(`https://api.sendgrid.com/v3/suppression/unsubscribes?limit=${limit}&offset=${offset}`, {
            headers: { 'Authorization': `Bearer ${SG_KEY}` }
        });
        if (!r.ok) break;
        const arr = await r.json();
        if (!Array.isArray(arr) || !arr.length) break;
        for (const row of arr) if (row && row.email) out.push(String(row.email).toLowerCase());
        if (arr.length < limit) break;
        offset += limit;
        if (offset > 20000) break;
    }
    return out;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (!SG_KEY) return respond(500, { error: 'SENDGRID_API_KEY not configured' });
    if (!LIST_SUB) return respond(500, { error: 'SENDGRID_LIST_SUBSCRIBED env var missing' });

    // Auth — same pattern as other admin endpoints
    if (QUARRY_DATA_KEY) {
        const provided = event.headers['x-quarry-key'] || event.headers['X-Quarry-Key'] || '';
        if (provided !== QUARRY_DATA_KEY) return respond(401, { error: 'Missing or invalid x-quarry-key header' });
    }

    try {
        const subs = await loadSubscribers();
        const subscribedEmails = [];
        const seen = new Set();
        for (const s of subs) {
            const status = s.emailStatus || s.status || '';
            const email = (s.email || '').trim().toLowerCase();
            if (status === 'Subscribed' && email && !seen.has(email)) {
                subscribedEmails.push(email);
                seen.add(email);
            }
        }

        // Bulk look up in SendGrid (100 per request)
        const batches = chunk(subscribedEmails, 100);
        const lookup = {};
        for (const b of batches) {
            const res = await sgBulkLookup(b);
            for (const k of Object.keys(res)) lookup[k.toLowerCase()] = res[k];
        }

        // Load suppression lists (already-suppressed contacts wouldn't have been emailed
        // even if they ARE in LIST_SUB)
        const [bounces, blocks, spamReports, invalids, unsubs] = await Promise.all([
            loadSuppressionList('bounces').catch(() => []),
            loadSuppressionList('blocks').catch(() => []),
            loadSuppressionList('spam_reports').catch(() => []),
            loadSuppressionList('invalid_emails').catch(() => []),
            loadGlobalUnsubs().catch(() => [])
        ]);
        const suppressedSet = new Set([...bounces, ...blocks, ...spamReports, ...invalids, ...unsubs]);

        const buckets = {
            inListSub: [],
            inSGNotInList: [],
            notInSendGrid: [],
            inListButSuppressed: []
        };
        for (const email of subscribedEmails) {
            const r = lookup[email];
            if (!r || !r.contact) {
                buckets.notInSendGrid.push(email);
                continue;
            }
            const lists = r.contact.list_ids || [];
            const inList = lists.includes(LIST_SUB);
            if (!inList) {
                buckets.inSGNotInList.push(email);
            } else if (suppressedSet.has(email)) {
                buckets.inListButSuppressed.push(email);
            } else {
                buckets.inListSub.push(email);
            }
        }

        return respond(200, {
            ok: true,
            list_id_subscribed: LIST_SUB,
            counts: {
                subscribersJson_subscribedTotal: subscribedEmails.length,
                inListSub: buckets.inListSub.length,
                inSGNotInList: buckets.inSGNotInList.length,
                notInSendGrid: buckets.notInSendGrid.length,
                inListButSuppressed: buckets.inListButSuppressed.length
            },
            samples: {
                inSGNotInList: buckets.inSGNotInList.slice(0, 25),
                notInSendGrid: buckets.notInSendGrid.slice(0, 25),
                inListButSuppressed: buckets.inListButSuppressed.slice(0, 25)
            },
            full: {
                inSGNotInList: buckets.inSGNotInList,
                notInSendGrid: buckets.notInSendGrid,
                inListButSuppressed: buckets.inListButSuppressed
            }
        });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
