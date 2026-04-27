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

async function fireMetaPost(draft) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/meta-post`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            platforms: draft.platforms || ['facebook', 'instagram'],
            caption: draft.caption,
            imageUrl: draft.imageUrl,
            linkUrl: draft.linkUrl || null,
            hashtags: draft.hashtags || [],
            scheduledFor: null  // we publish immediately; calendar handles scheduling on our side
        })
    });
    const body = await r.json();
    if (!r.ok) throw new Error(`meta-post failed: ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
    return body;
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
                const r = await fireMetaPost(draft);
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
