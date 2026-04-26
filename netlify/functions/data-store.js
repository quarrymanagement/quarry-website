// ============================================================================
// data-store.js — Generic GitHub-backed JSON store for the Quarry portal.
//
// GET  /.netlify/functions/data-store?file=marketing_drafts.json
// PUT  /.netlify/functions/data-store?file=marketing_drafts.json
//      body: { content: <base64>, sha: <prev-sha>, message: <commit msg> }
//
// Whitelist enforced — only known marketing/operations files are reachable
// so this can never be used to write arbitrary repo paths.
//
// Auth: x-quarry-key header (must match QUARRY_DATA_KEY env var) for writes.
//       Reads are open (the repo file is publicly readable anyway).
// ============================================================================

const fetch = require('node-fetch');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const QUARRY_DATA_KEY = process.env.QUARRY_DATA_KEY || ''; // optional; if blank, writes still require GITHUB_TOKEN to be set

const ALLOWED_FILES = new Set([
    'marketing_drafts.json',
    'marketing_calendar.json',
    'marketing_events.json',
    'marketing_learnings.json',
    'events.json'  // mirror github-proxy.js so we have one read/write surface long-term
]);

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-quarry-key',
    'Content-Type': 'application/json'
};

const respond = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

    if (!GITHUB_TOKEN) {
        return respond(500, { error: 'GITHUB_TOKEN not configured in Netlify env vars' });
    }

    const file = (event.queryStringParameters && event.queryStringParameters.file) || '';
    if (!ALLOWED_FILES.has(file)) {
        return respond(400, { error: `File '${file}' is not in the allowed list. Allowed: ${[...ALLOWED_FILES].join(', ')}` });
    }

    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${file}`;

    try {
        if (event.httpMethod === 'GET') {
            const resp = await fetch(url, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            if (!resp.ok) {
                const text = await resp.text();
                return respond(resp.status, { error: `GitHub GET failed: ${resp.status}`, details: text.slice(0, 500) });
            }
            const data = await resp.json();
            // Decode content for convenience; client may also use the base64 + sha as-is.
            let decoded = null;
            if (data.content && data.encoding === 'base64') {
                try { decoded = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')); } catch (_) { decoded = null; }
            }
            return respond(200, { sha: data.sha, path: data.path, decoded, raw: data });
        }

        if (event.httpMethod === 'PUT') {
            // Write protection: require QUARRY_DATA_KEY header match if env var is set
            if (QUARRY_DATA_KEY) {
                const provided = event.headers['x-quarry-key'] || event.headers['X-Quarry-Key'] || '';
                if (provided !== QUARRY_DATA_KEY) {
                    return respond(401, { error: 'Missing or invalid x-quarry-key header' });
                }
            }

            const body = JSON.parse(event.body || '{}');
            // Accept either pre-encoded content (base64) OR a JSON object to encode here
            let content = body.content;
            if (!content && body.json !== undefined) {
                content = Buffer.from(JSON.stringify(body.json, null, 2), 'utf8').toString('base64');
            }
            if (!content) return respond(400, { error: 'Body must include content (base64) or json (object).' });

            const putResp = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/vnd.github.v3+json'
                },
                body: JSON.stringify({
                    message: body.message || `update ${file}`,
                    content,
                    sha: body.sha  // omit on first create; required on update
                })
            });
            const result = await putResp.json();
            if (!putResp.ok) {
                return respond(putResp.status, { error: result.message || 'GitHub PUT failed', details: result });
            }
            return respond(200, { ok: true, sha: result.content && result.content.sha, commit: result.commit && result.commit.sha });
        }

        return respond(405, { error: 'Method not allowed' });
    } catch (err) {
        return respond(500, { error: 'data-store error: ' + err.message });
    }
};
