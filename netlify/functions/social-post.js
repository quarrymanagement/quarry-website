// ============================================================================
// social-post.js — Drains approved social drafts to Facebook + Instagram
//
// Cron-polled (every 10 min). For each draft where:
//   status === 'approved' AND scheduledFor <= now
// posts to the platforms specified, marks as 'posted', records the FB post ID
// and IG media ID for later stats polling.
//
// Mode: 'sendNow' — immediate post for a specific draftId
// ============================================================================

const fetch = require('node-fetch');
const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';

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

// ----------------------------------------------------------------------------
// UTM tagging — every link in every published caption gets attribution params
// so we can measure post → ticket sale / RSVP in Google Analytics.
// ----------------------------------------------------------------------------
const URL_REGEX = /(https?:\/\/[^\s)"']+)/g;
function appendUtmsToLink(url, platform, campaign) {
    try {
        const u = new URL(url);
        // Only tag our own domain — external links would just collect noise.
        if (!/(thequarrystl\.com|netlify\.app)/i.test(u.hostname)) return url;
        if (!u.searchParams.has('utm_source'))   u.searchParams.set('utm_source', platform);
        if (!u.searchParams.has('utm_medium'))   u.searchParams.set('utm_medium', 'social');
        if (!u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', campaign || 'social');
        return u.toString();
    } catch (_) { return url; }
}
function tagLinksInText(text, platform, campaign) {
    if (!text) return text;
    return text.replace(URL_REGEX, (m) => appendUtmsToLink(m, platform, campaign));
}

async function fireMetaPostPerPlatform(draft) {
    // Post each platform separately so we can UTM-tag the captions independently.
    const platforms = draft.platforms || ['facebook', 'instagram'];
    const campaign = draft.cadenceTag || ('social-' + (draft.type || 'post'));
    const allResults = [];
    for (const p of platforms) {
        const taggedCaption = tagLinksInText(draft.caption, p, campaign);
        const taggedLinkUrl = draft.linkUrl ? appendUtmsToLink(draft.linkUrl, p, campaign) : null;
        const imageUrl = draft.userImageUrl || draft.imageUrl;
        const r = await fetch(`${SITE_URL}/.netlify/functions/meta-post`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platforms: [p],
                caption: taggedCaption,
                imageUrl,
                linkUrl: taggedLinkUrl,
                hashtags: draft.hashtags || [],
                scheduledFor: null
            })
        });
        const body = await r.json();
        if (!r.ok) {
            allResults.push({ platform: p, ok: false, error: body.error || `meta-post ${r.status}` });
        } else {
            (body.results || []).forEach((x) => allResults.push(x));
            // Carry through dry-run flag if we hit one
            if (body.dryRun) allResults[allResults.length - 1] = Object.assign(allResults[allResults.length - 1] || { platform: p, ok: true }, { dryRun: true });
        }
    }
    const ok = allResults.every((r) => !r.error);
    const dryRun = allResults.some((r) => r.dryRun);
    return { ok, results: allResults, dryRun };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) {}
    const mode = body.mode || 'poll';

    try {
        const draftsRes = await loadFile('social_drafts.json');
        const file = draftsRes.data;
        const drafts = Array.isArray(file.drafts) ? file.drafts : [];

        const now = Date.now();
        const queue = mode === 'sendNow'
            ? drafts.filter((d) => d.id === body.draftId && (d.status === 'approved' || d.status === 'pending'))
            : drafts.filter((d) => d.status === 'approved' && d.scheduledFor && new Date(d.scheduledFor).getTime() <= now);

        if (!queue.length) return respond(200, { ok: true, mode, sentCount: 0, message: 'nothing to send' });

        const results = [];
        let mutated = false;
        for (const draft of queue) {
            try {
                const r = await fireMetaPostPerPlatform(draft);
                draft.status = 'posted';
                draft.postedAt = new Date().toISOString();
                draft.updatedAt = draft.postedAt;
                // Pull post IDs from the meta-post response
                const fbResult = (r.results || []).find((x) => x.platform === 'facebook');
                const igResult = (r.results || []).find((x) => x.platform === 'instagram');
                if (fbResult) draft.fbPostId = fbResult.postId || null;
                if (igResult) draft.igMediaId = igResult.mediaId || null;
                draft.dryRun = !!r.dryRun;
                results.push({ id: draft.id, ok: true, platforms: r.results, dryRun: r.dryRun });
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
            await saveFile('social_drafts.json', file, draftsRes.sha,
                `social-post: ${results.filter((r) => r.ok).length} posted, ${results.filter((r) => !r.ok).length} failed`);
        }
        return respond(200, { ok: true, mode, results, sentCount: results.filter((r) => r.ok).length });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
