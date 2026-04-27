// ============================================================================
// social-image-gen.js
//
// Generate a hero image for a social post using DALL-E 3, save to GitHub
// under /assets/social-images/{draftId}.png, return public URL.
//
// POST /.netlify/functions/social-image-gen
// body: { prompt: '...', draftId: '...', size: '1024x1024' (default) }
//
// Why DALL-E 3 (not 2): better composition, much better at restaurant /
// food / atmospheric photography. ~$0.04 per image.
//
// We post-process: download the OpenAI-hosted image, base64-encode, commit to
// our GitHub repo so it lives at a stable URL on our CDN (DALL-E URLs expire).
// ============================================================================

const https = require('https');
const fetch = require('node-fetch');

const SITE_URL  = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'quarrymanagement/quarry-website';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function callDallE(prompt, size) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: 'dall-e-3',
            prompt,
            size: size || '1024x1024',
            quality: 'standard',
            n: 1,
            response_format: 'url'
        });
        const req = https.request({
            hostname: 'api.openai.com', path: '/v1/images/generations', method: 'POST',
            headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`DALL-E ${res.statusCode}: ${body.slice(0, 400)}`));
                try { const p = JSON.parse(body); resolve(p.data && p.data[0] && p.data[0].url); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject); req.write(payload); req.end();
    });
}

async function downloadAsBuffer(url) {
    const r = await fetch(url, { timeout: 30000 });
    if (!r.ok) throw new Error(`download image: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
}

async function commitImageToRepo(filename, buffer) {
    const path = `assets/social-images/${filename}`;
    const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
    // Check if exists (for sha)
    let sha = null;
    try {
        const get = await fetch(url, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } });
        if (get.ok) { const data = await get.json(); sha = data.sha; }
    } catch (_) {}
    const put = await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json' },
        body: JSON.stringify({
            message: `social-image-gen: ${filename}`,
            content: buffer.toString('base64'),
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
    if (!OPENAI_KEY)   return respond(500, { error: 'OPENAI_API_KEY not configured' });
    if (!GITHUB_TOKEN) return respond(500, { error: 'GITHUB_TOKEN not configured' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { error: 'Invalid JSON' }); }

    const { prompt, draftId, size } = body;
    if (!prompt) return respond(400, { error: 'prompt required' });
    if (!draftId) return respond(400, { error: 'draftId required (used as filename)' });

    try {
        // Brand-amplify the prompt
        const fullPrompt = `${prompt}\n\nStyle: warm photographic, golden hour lighting, professional restaurant marketing photography. Inviting, upscale-casual atmosphere. Color palette emphasizes brand gold and cream tones. NO people or faces. NO text, logos, or readable signage in the image.`;
        const dalleUrl = await callDallE(fullPrompt, size || '1024x1024');
        const buffer = await downloadAsBuffer(dalleUrl);
        const filename = `${draftId.slice(0, 32)}.png`;
        const publicUrl = await commitImageToRepo(filename, buffer);
        return respond(200, { success: true, url: publicUrl, filename, dallePrompt: fullPrompt, sizeBytes: buffer.length });
    } catch (err) {
        return respond(500, { success: false, error: err.message });
    }
};
