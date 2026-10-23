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
// Auth (2026-10-23 lockdown):
//   - Anonymous GET only for files in data-read's PUBLIC_FILES allowlist
//     (of the files below, that is just events.json).
//   - Every other GET, and every PUT, needs either an admin/staff session token
//     (x-admin-token header / ?token= / body.adminToken, see _admin-auth.js) or
//     the server-to-server key (x-quarry-key, see _internal-auth.js).
// ============================================================================

const fetch = require('node-fetch');
const { vaultAndStrip } = require('./_event-pii');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const { isAuthorized } = require('./_admin-auth');
const { isInternal } = require('./_internal-auth');
const { PUBLIC_FILES } = require('./data-read');

// Staff roles allowed in addition to the owner token. events_staff (Penny) has
// the dashboard tab, which reads the social/marketing draft counts.
const STAFF_ROLES = ['events_staff'];

const ALLOWED_FILES = new Set([
    'marketing_drafts.json',
    'marketing_calendar.json',
    'marketing_events.json',
    'marketing_learnings.json',
    'marketing_crm.json',
    'subscribers.json',
    'social_drafts.json',
    'social_calendar.json',
    'social_events.json',
    'social_learnings.json',
    'social_assets.json',
    'reservations_status.json',
    'events.json',
    'catchup_status.json'  // mirror github-proxy.js so we have one read/write surface long-term
]);

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-quarry-key, x-admin-token',
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
        return respond(400, { error: `File '${file}' is not in the allowed list.` });
    }

    const publicRead = event.httpMethod === 'GET' && PUBLIC_FILES.has(file);
    if (!publicRead && !isInternal(event)) {
        let parsedBody = null;
        if (event.httpMethod === 'PUT') { try { parsedBody = JSON.parse(event.body || '{}'); } catch (_) { parsedBody = null; } }
        if (!isAuthorized(event, parsedBody, STAFF_ROLES)) {
            return respond(401, { error: 'Admin session required' });
        }
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
            } else if (data.git_url) {
                // Fallback: GitHub Contents API drops `content` for files >1 MB.
                // Use the Git Data API (blob endpoint) which has a 100 MB limit.
                try {
                    const blobResp = await fetch(data.git_url, {
                        headers: {
                            'Authorization': `token ${GITHUB_TOKEN}`,
                            'Accept': 'application/vnd.github.v3+json'
                        }
                    });
                    if (blobResp.ok) {
                        const blob = await blobResp.json();
                        if (blob.content && blob.encoding === 'base64') {
                            try { decoded = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')); } catch (_) { decoded = null; }
                        }
                    }
                } catch (_) { /* leave decoded null */ }
            }
            return respond(200, { sha: data.sha, path: data.path, size: data.size, decoded, raw: data });
        }

        if (event.httpMethod === 'PUT') {
            // Auth already enforced above (session token or x-quarry-key).
            const body = JSON.parse(event.body || '{}');
            // Accept either pre-encoded content (base64) OR a JSON object to encode here
            let content = body.content;
            if (!content && body.json !== undefined) {
                content = Buffer.from(JSON.stringify(body.json, null, 2), 'utf8').toString('base64');
            }
            if (!content) return respond(400, { error: 'Body must include content (base64) or json (object).' });

            // 2026-10-22: events.json lives in a PUBLIC repo. Vault buyer PII in
            // Supabase and strip it before committing (aborts on vault failure).
            if (file === 'events.json') {
                let doc;
                try { doc = JSON.parse(Buffer.from(content, 'base64').toString('utf8')); }
                catch (_) { return respond(400, { error: 'events.json content is not valid JSON' }); }
                try { await vaultAndStrip(doc, 'data-store'); }
                catch (e) { return respond(503, { error: 'PII vault unavailable; events.json not written: ' + e.message }); }
                content = Buffer.from(JSON.stringify(doc, null, 2), 'utf8').toString('base64');
            }

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
