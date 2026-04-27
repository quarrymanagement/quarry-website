// ============================================================================
// social-poll-stats.js
//
// Cron-driven (every 30 min). For each posted draft in the last 30 days,
// pulls engagement metrics from Meta Graph API and writes them into
// social_events.json aggregates.
//
// Facebook insights endpoint: /{post_id}/insights?metric=post_impressions,post_engagements,...
// Instagram insights endpoint: /{media_id}/insights?metric=reach,impressions,...
//
// Free for any volume of posts on your own pages.
// ============================================================================

const fetch = require('node-fetch');
const SITE_URL   = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const PAGE_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || '';
const API_BASE   = 'https://graph.facebook.com/v18.0';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

async function loadFile(file) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`);
    if (!r.ok) throw new Error(`load ${file}: ${r.status}`);
    const d = await r.json();
    return { data: d.decoded || {}, sha: d.sha };
}
async function saveFile(file, json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json, sha, message })
    });
    if (!r.ok) throw new Error(`save ${file}: ${r.status}`);
    return r.json();
}

async function fbPostInsights(postId) {
    // Facebook Page post insights
    const metrics = 'post_impressions,post_impressions_unique,post_engaged_users,post_clicks,post_reactions_by_type_total';
    const r = await fetch(`${API_BASE}/${postId}/insights?metric=${metrics}&access_token=${PAGE_TOKEN}`);
    if (!r.ok) throw new Error(`FB insights ${r.status}`);
    const data = await r.json();
    const out = { impressions: 0, reach: 0, engagements: 0, clicks: 0, likes: 0 };
    for (const m of (data.data || [])) {
        const v = (m.values && m.values[0] && m.values[0].value) || 0;
        if (m.name === 'post_impressions') out.impressions = v;
        else if (m.name === 'post_impressions_unique') out.reach = v;
        else if (m.name === 'post_engaged_users') out.engagements = v;
        else if (m.name === 'post_clicks') out.clicks = v;
        else if (m.name === 'post_reactions_by_type_total' && typeof v === 'object') {
            out.likes = (v.like || 0) + (v.love || 0) + (v.wow || 0) + (v.haha || 0);
        }
    }
    return out;
}

async function igMediaInsights(mediaId) {
    const metrics = 'reach,impressions,likes,comments,saved,shares';
    const r = await fetch(`${API_BASE}/${mediaId}/insights?metric=${metrics}&access_token=${PAGE_TOKEN}`);
    if (!r.ok) throw new Error(`IG insights ${r.status}`);
    const data = await r.json();
    const out = { impressions: 0, reach: 0, likes: 0, comments: 0, saves: 0, shares: 0 };
    for (const m of (data.data || [])) {
        const v = (m.values && m.values[0] && m.values[0].value) || 0;
        if (m.name === 'reach') out.reach = v;
        else if (m.name === 'impressions') out.impressions = v;
        else if (m.name === 'likes') out.likes = v;
        else if (m.name === 'comments') out.comments = v;
        else if (m.name === 'saved') out.saves = v;
        else if (m.name === 'shares') out.shares = v;
    }
    return out;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (!PAGE_TOKEN) return respond(200, { ok: true, skipped: 'META_PAGE_ACCESS_TOKEN not configured (dev mode)' });

    try {
        const draftsRes = await loadFile('social_drafts.json');
        const eventsRes = await loadFile('social_events.json');
        const drafts = (draftsRes.data.drafts || []).concat(draftsRes.data.history || []);
        const file = eventsRes.data;
        file.aggregates = file.aggregates || {};
        file.events = Array.isArray(file.events) ? file.events : [];

        const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
        const eligible = drafts.filter((d) =>
            (d.fbPostId || d.igMediaId) &&
            d.postedAt && new Date(d.postedAt).getTime() >= cutoff
        );

        let polled = 0, errors = [];
        for (const d of eligible) {
            const agg = file.aggregates[d.id] || {};
            try {
                if (d.fbPostId) agg.facebook = await fbPostInsights(d.fbPostId);
                if (d.igMediaId) agg.instagram = await igMediaInsights(d.igMediaId);
                agg.lastPolledAt = new Date().toISOString();
                file.aggregates[d.id] = agg;
                file.events.push({
                    ts: agg.lastPolledAt, type: 'poll', draftId: d.id,
                    fbPostId: d.fbPostId || null, igMediaId: d.igMediaId || null,
                    summary: agg
                });
                polled++;
            } catch (err) {
                errors.push({ draftId: d.id, error: err.message });
            }
        }

        if (file.events.length > 5000) file.events = file.events.slice(-5000);
        if (polled > 0 || errors.length > 0) {
            file.updatedAt = new Date().toISOString();
            await saveFile('social_events.json', file, eventsRes.sha, `social-poll: ${polled} polled, ${errors.length} errors`);
        }
        return respond(200, { ok: true, polledCount: polled, errorsCount: errors.length, errors: errors.slice(0, 5) });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
