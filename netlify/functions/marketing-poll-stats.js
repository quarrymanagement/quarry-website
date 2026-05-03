// ============================================================================
// marketing-poll-stats.js
//
// Replaces the SendGrid Event Webhook (which Basic 5k plan doesn't include).
// Cron-triggered every 15 minutes. For each draft that has a sgSingleSendId
// and was sent in the last 30 days, pulls aggregate stats from SendGrid's
// Single Send stats endpoint and writes them into marketing_events.json
// aggregates so the Performance dashboard + AI optimizer keep working.
//
// SendGrid endpoint:
//   GET /v3/marketing/stats/singlesends/{id}
//   Response includes: delivered, opens, unique_opens, clicks, unique_clicks,
//                      bounces, unsubscribes, spam_reports, requests, etc.
//
// Schedule: every 15 minutes (configured in netlify.toml).
// Env: SENDGRID_API_KEY
// ============================================================================

const fetch = require('node-fetch');

const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const SG_KEY = process.env.SENDGRID_API_KEY;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};
const respond = (s, b) => ({ statusCode: s, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

async function loadJsonFile(file) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`);
    if (!r.ok) throw new Error(`load ${file}: ${r.status}`);
    const d = await r.json();
    return { data: d.decoded || {}, sha: d.sha };
}
async function saveJsonFile(file, json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json, sha, message })
    });
    if (!r.ok) throw new Error(`save ${file}: ${r.status}`);
    return r.json();
}

async function fetchSingleSendStats(sendId) {
    // Aggregate stats per Single Send. Returns array of date-bucketed rows;
    // we sum them up since we want totals not time-series.
    const r = await fetch(`https://api.sendgrid.com/v3/marketing/stats/singlesends/${sendId}`, {
        headers: { 'Authorization': `Bearer ${SG_KEY}` }
    });
    if (r.status === 404) return null; // send still queued / not yet stats-eligible
    if (!r.ok) {
        const text = await r.text();
        throw new Error(`stats fetch (${sendId}): ${r.status} ${text.slice(0, 200)}`);
    }
    const data = await r.json();
    // Response shape: { id, results: [{ stats: { delivered, unique_opens, unique_clicks, bounces, unsubscribes, spam_reports, requests, blocks } }, ...] }
    const buckets = data.results || [];
    const totals = { requests: 0, delivered: 0, open: 0, uniqueOpen: 0, click: 0, uniqueClick: 0, bounce: 0, unsubscribe: 0, spamreport: 0, block: 0 };
    for (const b of buckets) {
        const s = b.stats || {};
        totals.requests   += s.requests          || 0;
        totals.delivered  += s.delivered         || 0;
        totals.open       += s.opens             || 0;
        totals.uniqueOpen += s.unique_opens      || 0;
        totals.click      += s.clicks            || 0;
        totals.uniqueClick+= s.unique_clicks     || 0;
        totals.bounce     += s.bounces           || 0;
        totals.unsubscribe+= s.unsubscribes      || 0;
        totals.spamreport += s.spam_reports      || 0;
        totals.block      += s.blocks            || 0;
    }
    return totals;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (!SG_KEY) return respond(500, { error: 'SENDGRID_API_KEY not configured' });

    try {
        const draftsRes = await loadJsonFile('marketing_drafts.json');
        const eventsRes = await loadJsonFile('marketing_events.json');
        const drafts = (draftsRes.data.drafts || []).concat(draftsRes.data.history || []);
        const file = eventsRes.data;
        file.aggregates = file.aggregates || {};
        file.events = Array.isArray(file.events) ? file.events : [];

        const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
        const eligible = drafts.filter((d) =>
            d.sgSingleSendId &&
            d.sentAt && new Date(d.sentAt).getTime() >= cutoff
        );

        let polled = 0, updated = 0, errors = [];
        for (const d of eligible) {
            try {
                const stats = await fetchSingleSendStats(d.sgSingleSendId);
                if (!stats) continue; // not stats-eligible yet
                polled++;
                const prev = file.aggregates[d.id] || {};
                const next = Object.assign({}, prev, stats);
                next.lastPolledAt = new Date().toISOString();
                // detect new events for the activity log (just record the deltas)
                const deltaOpen = (stats.uniqueOpen || 0) - (prev.uniqueOpen || 0);
                const deltaClick = (stats.uniqueClick || 0) - (prev.uniqueClick || 0);
                const deltaUnsub = (stats.unsubscribe || 0) - (prev.unsubscribe || 0);
                const hasDelta = deltaOpen + deltaClick + deltaUnsub > 0;
                if (hasDelta) updated++;
                file.aggregates[d.id] = next;
                // Only log a poll event when something actually moved. Otherwise
                // we were committing a fresh poll log every 15 min for stats
                // that hadn't changed in days — pure noise.
                if (hasDelta) {
                    file.events.push({
                        ts: new Date().toISOString(),
                        type: 'poll',
                        draftId: d.id,
                        sendId: d.sgSingleSendId,
                        summary: { opens: stats.uniqueOpen, clicks: stats.uniqueClick, bounces: stats.bounce, unsubs: stats.unsubscribe }
                    });
                }
            } catch (err) {
                errors.push({ draftId: d.id, sendId: d.sgSingleSendId, err: err.message });
            }
        }

        // Trim events log to last 5,000 entries
        if (file.events.length > 5000) file.events = file.events.slice(-5000);

        // Only commit when we have NEW data. Errors get logged in the
        // function logs and surfaced in the API response — they don't need to
        // be persisted to GitHub on every cron tick (was ~93% noise commits).
        if (updated > 0) {
            file.updatedAt = new Date().toISOString();
            await saveJsonFile('marketing_events.json', file, eventsRes.sha,
                `poll-stats: ${polled} polled, ${updated} updated, ${errors.length} errors`);
        }

        return respond(200, { ok: true, polledCount: polled, updatedCount: updated, errorsCount: errors.length, errors: errors.slice(0, 5) });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
