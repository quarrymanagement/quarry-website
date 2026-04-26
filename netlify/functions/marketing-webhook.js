// ============================================================================
// marketing-webhook.js
//
// SendGrid Event Webhook receiver.
// Configure in SendGrid: Settings → Mail Settings → Event Webhook
//   POST URL: https://thequarrystl.com/.netlify/functions/marketing-webhook
//   Events to track: Delivered, Opened, Clicked, Bounced, Dropped,
//                    Spam Reports, Unsubscribed
//
// Stores raw events in marketing_events.json (capped to last ~10k entries)
// AND maintains per-draft aggregates so dashboard reads stay snappy.
//
// Custom args we set on send (in marketing-send.js): draft_id, rule_id, email
// — these come back on every event so we can attribute reliably.
// ============================================================================

const fetch = require('node-fetch');

const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const QUARRY_DATA_KEY = process.env.QUARRY_DATA_KEY || '';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};
const respond = (statusCode, body) => ({ statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const MAX_EVENTS_RETAINED = 10000;

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

function emptyAgg() {
    return { delivered: 0, open: 0, uniqueOpen: 0, click: 0, uniqueClick: 0, bounce: 0, unsubscribe: 0, spamreport: 0, dropped: 0, lastEventAt: null, openersByEmail: {}, clickersByEmail: {}, urlsClicked: {} };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });

    let payload;
    try {
        payload = JSON.parse(event.body || '[]');
        if (!Array.isArray(payload)) payload = [payload];
    } catch (e) {
        return respond(400, { error: 'Invalid JSON body' });
    }

    try {
        const eventsRes = await loadJsonFile('marketing_events.json');
        const file = eventsRes.data;
        const events = Array.isArray(file.events) ? file.events : [];
        const aggregates = file.aggregates || {};

        // Deduplicate by sg_event_id
        const seen = new Set(events.map((e) => e.sgEventId).filter(Boolean));
        const sentenceCase = (s) => (s || '').replace(/_/g, ' ');

        let added = 0;
        for (const ev of payload) {
            if (!ev || typeof ev !== 'object') continue;
            const sgEventId = ev.sg_event_id || (ev.timestamp + ':' + (ev.email || '') + ':' + (ev.event || ''));
            if (seen.has(sgEventId)) continue;
            seen.add(sgEventId);

            const draftId = ev.draft_id || (ev.unique_args && ev.unique_args.draft_id) || null;
            const ruleId = ev.rule_id || null;
            const email = (ev.email || '').toLowerCase();
            const type = ev.event || 'unknown';

            const stored = {
                ts: ev.timestamp ? new Date(ev.timestamp * 1000).toISOString() : new Date().toISOString(),
                type,
                draftId,
                ruleId,
                email,
                url: ev.url || null,
                sgEventId,
                userAgent: ev.useragent || null,
                category: Array.isArray(ev.category) ? ev.category[0] : (ev.category || null)
            };
            events.push(stored);
            added++;

            // Update aggregates per-draft
            if (draftId) {
                if (!aggregates[draftId]) aggregates[draftId] = emptyAgg();
                const a = aggregates[draftId];
                a.lastEventAt = stored.ts;
                if (a[type] !== undefined) a[type]++;
                if (type === 'open' && email) {
                    if (!a.openersByEmail[email]) { a.openersByEmail[email] = stored.ts; a.uniqueOpen++; }
                }
                if (type === 'click' && email) {
                    if (!a.clickersByEmail[email]) { a.clickersByEmail[email] = stored.ts; a.uniqueClick++; }
                    if (stored.url) a.urlsClicked[stored.url] = (a.urlsClicked[stored.url] || 0) + 1;
                }
            }
        }

        // Trim oldest events if we're over cap
        let trimmed = false;
        if (events.length > MAX_EVENTS_RETAINED) {
            events.sort((a, b) => (a.ts < b.ts ? -1 : 1));
            const remove = events.length - MAX_EVENTS_RETAINED;
            events.splice(0, remove);
            trimmed = true;
        }

        if (added > 0 || trimmed) {
            file.events = events;
            file.aggregates = aggregates;
            file.updatedAt = new Date().toISOString();
            await saveJsonFile('marketing_events.json', file, eventsRes.sha,
                `webhook: +${added} events${trimmed ? ' (trimmed)' : ''}`);
        }

        return respond(200, { ok: true, added });
    } catch (err) {
        // Always 200 to SendGrid so they don't endlessly retry on transient
        // GitHub blips — but include the error for observability.
        return respond(200, { ok: false, error: err.message });
    }
};
