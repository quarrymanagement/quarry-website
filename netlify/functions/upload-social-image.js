// ============================================================================
// upload-social-image.js
//
// Accepts a base64-encoded image (PNG/JPG) from the admin's social draft modal,
// stores it in /assets/social-uploads/{draftId}-{ts}.{ext} via GitHub PUT,
// returns a stable public URL on thequarrystl.com.
//
// POST /.netlify/functions/upload-social-image
// body: { imageBase64: 'data:image/png;base64,...', filename: 'optional.png', draftId: '...' }
//
// Why GitHub commit (not S3): same pattern as social-image-gen.js — gives us a
// stable CDN URL on our own domain, version-controlled, no extra infra.
// ============================================================================

const fetch = require('node-fetch');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'quarrymanagement/quarry-website';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

// Allowed MIME prefixes → file extensions
const MIME_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
};

const MAX_BYTES = 8 * 1024 * 1024;  // 8 MB hard cap (Meta IG limit is 8MB anyway)

function parseDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return null;
    return { mime: m[1].toLowerCase(), b64: m[2] };
}

async function commitImageToRepo(path, base64) {
    const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
    // Check if exists (for sha) — typically won't, since we timestamp filenames
    let sha = null;
    try {
        const get = await fetch(url, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } });
        if (get.ok) { const data = await get.json(); sha = data.sha; }
    } catch (_) {}
    const put = await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json' },
        body: JSON.stringify({
            message: `social-upload: ${path.split('/').pop()}`,
            content: base64,
            sha: sha || undefined
        })
    });
    if (!put.ok) {
        const t = await put.text();
        throw new Error(`commit failed: ${put.status} ${t.slice(0, 200)}`);
    }
    return `https://thequarrystl.com/${path}`;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });
    if (!GITHUB_TOKEN) return respond(500, { error: 'GITHUB_TOKEN not configured' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { error: 'Invalid JSON' }); }

    const { imageBase64, draftId, filename } = body;
    if (!imageBase64) return respond(400, { error: 'imageBase64 required (data:image/...;base64,... format)' });

    const parsed = parseDataUrl(imageBase64);
    if (!parsed) return respond(400, { error: 'imageBase64 must be a data URL like "data:image/png;base64,..."' });

    const ext = MIME_EXT[parsed.mime];
    if (!ext) return respond(400, { error: `Unsupported image type: ${parsed.mime}. Allowed: ${Object.keys(MIME_EXT).join(', ')}` });

    // Approximate size from base64 length (4 chars = 3 bytes)
    const approxBytes = Math.floor(parsed.b64.length * 3 / 4);
    if (approxBytes > MAX_BYTES) {
        return respond(413, { error: `Image too large: ~${(approxBytes / 1024 / 1024).toFixed(1)} MB. Max is ${MAX_BYTES / 1024 / 1024} MB. Resize and try again.` });
    }

    // Filename: prefer draftId if given, else from filename, else timestamp
    const ts = Date.now();
    let baseName;
    if (draftId) baseName = `${draftId.slice(0, 32)}-${ts}`;
    else if (filename) baseName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[^.]+$/, '') + `-${ts}`;
    else baseName = `upload-${ts}`;
    const path = `assets/social-uploads/${baseName}.${ext}`;

    try {
        const publicUrl = await commitImageToRepo(path, parsed.b64);
        return respond(200, {
            success: true,
            url: publicUrl,
            path,
            filename: baseName + '.' + ext,
            sizeBytes: approxBytes,
            mime: parsed.mime
        });
    } catch (err) {
        return respond(500, { success: false, error: err.message });
    }
};
