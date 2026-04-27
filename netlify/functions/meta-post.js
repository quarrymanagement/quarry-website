// ============================================================================
// meta-post.js
//
// Posts content to Facebook Page and/or Instagram Business via Meta Graph API.
// Called by social-post.js (cron-driven sender).
//
// Supports test/dev mode: if META_PAGE_ACCESS_TOKEN isn't set, returns a
// dry-run response with the payload it WOULD have sent. Useful while user
// is still completing Meta setup.
//
// Env required:
//   META_PAGE_ACCESS_TOKEN  long-lived Page Access Token
//   META_PAGE_ID            FB Page numeric ID
//   META_IG_USER_ID         IG Business Account numeric ID (linked to FB Page)
//
// POST /.netlify/functions/meta-post
// body: {
//   platforms: ['facebook'] | ['instagram'] | ['facebook','instagram'],
//   caption: 'string',
//   imageUrl: 'https://...',  (required for IG, optional for FB)
//   linkUrl:  'https://...',  (FB only — IG strips links from feed)
//   hashtags: ['#a','#b'],
//   scheduledFor: 'ISO ts' | null,  (FB supports; IG does not — uses immediate)
//   dryRun: bool
// }
// ============================================================================

const fetch = require('node-fetch');

const PAGE_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || '';
const PAGE_ID    = process.env.META_PAGE_ID || '';
const IG_USER_ID = process.env.META_IG_USER_ID || '';
const API_BASE   = 'https://graph.facebook.com/v18.0';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function buildIgCaption(caption, hashtags) {
    const tags = (hashtags || []).join(' ');
    return [caption || '', tags].filter(Boolean).join('\n\n.\n.\n.\n');
}
function buildFbCaption(caption, hashtags) {
    // Facebook usually doesn't benefit from hashtags much — keep them short
    const tags = (hashtags || []).slice(0, 3).join(' ');
    return [caption || '', tags].filter(Boolean).join('\n\n');
}

// ----------------------------------------------------------------------------
// Facebook Page post
// ----------------------------------------------------------------------------
async function postToFacebook({ caption, imageUrl, linkUrl, hashtags, scheduledFor }) {
    const message = buildFbCaption(caption, hashtags);
    let endpoint, body;

    if (imageUrl) {
        // Photo post — POST to /{page-id}/photos with url param
        endpoint = `${API_BASE}/${PAGE_ID}/photos`;
        body = new URLSearchParams({
            url: imageUrl,
            caption: message,
            access_token: PAGE_TOKEN
        });
    } else if (linkUrl) {
        // Link post — POST to /{page-id}/feed with link param
        endpoint = `${API_BASE}/${PAGE_ID}/feed`;
        body = new URLSearchParams({
            message,
            link: linkUrl,
            access_token: PAGE_TOKEN
        });
    } else {
        // Text-only post
        endpoint = `${API_BASE}/${PAGE_ID}/feed`;
        body = new URLSearchParams({ message, access_token: PAGE_TOKEN });
    }

    if (scheduledFor) {
        const ts = Math.floor(new Date(scheduledFor).getTime() / 1000);
        const now = Math.floor(Date.now() / 1000);
        // Meta requires scheduled posts at least 10 min in future, max 6 months
        if (ts > now + 600 && ts < now + (180 * 86400)) {
            body.append('published', 'false');
            body.append('scheduled_publish_time', String(ts));
        }
    }

    const r = await fetch(endpoint, { method: 'POST', body });
    const data = await r.json();
    if (!r.ok || data.error) {
        throw new Error(`FB ${r.status}: ${(data.error && data.error.message) || JSON.stringify(data).slice(0, 200)}`);
    }
    return { platform: 'facebook', postId: data.id || data.post_id, raw: data };
}

// ----------------------------------------------------------------------------
// Instagram Business post — TWO-step: create container, then publish
// ----------------------------------------------------------------------------
async function postToInstagram({ caption, imageUrl, hashtags }) {
    if (!imageUrl) throw new Error('Instagram requires an imageUrl (no text-only posts allowed via API)');
    const fullCaption = buildIgCaption(caption, hashtags);

    // Step 1: create the media container
    const createBody = new URLSearchParams({
        image_url: imageUrl,
        caption: fullCaption,
        access_token: PAGE_TOKEN
    });
    const create = await fetch(`${API_BASE}/${IG_USER_ID}/media`, { method: 'POST', body: createBody });
    const createData = await create.json();
    if (!create.ok || createData.error) {
        throw new Error(`IG create ${create.status}: ${(createData.error && createData.error.message) || JSON.stringify(createData).slice(0, 200)}`);
    }
    const containerId = createData.id;

    // Step 2: poll container status until ready (usually instant; cap at ~15s)
    for (let i = 0; i < 8; i++) {
        const status = await fetch(`${API_BASE}/${containerId}?fields=status_code&access_token=${PAGE_TOKEN}`);
        const sd = await status.json();
        if (sd.status_code === 'FINISHED') break;
        if (sd.status_code === 'ERROR' || sd.status_code === 'EXPIRED') {
            throw new Error(`IG container ${sd.status_code}: ${JSON.stringify(sd).slice(0, 200)}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
    }

    // Step 3: publish
    const publishBody = new URLSearchParams({ creation_id: containerId, access_token: PAGE_TOKEN });
    const pub = await fetch(`${API_BASE}/${IG_USER_ID}/media_publish`, { method: 'POST', body: publishBody });
    const pubData = await pub.json();
    if (!pub.ok || pubData.error) {
        throw new Error(`IG publish ${pub.status}: ${(pubData.error && pubData.error.message) || JSON.stringify(pubData).slice(0, 200)}`);
    }
    return { platform: 'instagram', mediaId: pubData.id, containerId, raw: pubData };
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------
exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { error: 'Invalid JSON' }); }

    const dryRun = body.dryRun || (!PAGE_TOKEN);

    if (dryRun) {
        return respond(200, {
            ok: true,
            dryRun: true,
            reason: !PAGE_TOKEN ? 'META_PAGE_ACCESS_TOKEN not configured — dry-run mode' : 'requested',
            wouldPost: body
        });
    }

    if (!PAGE_ID || !IG_USER_ID) {
        return respond(500, { error: 'META_PAGE_ID and/or META_IG_USER_ID not configured' });
    }

    const platforms = body.platforms || ['facebook', 'instagram'];
    const results = [];
    for (const p of platforms) {
        try {
            if (p === 'facebook') results.push(await postToFacebook(body));
            else if (p === 'instagram') results.push(await postToInstagram(body));
            else results.push({ platform: p, ok: false, error: 'unknown platform' });
        } catch (err) {
            results.push({ platform: p, ok: false, error: err.message });
        }
    }
    const ok = results.every((r) => !r.error);
    return respond(ok ? 200 : 500, { ok, results });
};
