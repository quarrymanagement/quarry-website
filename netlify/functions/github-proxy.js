const fetch = require('node-fetch');
const { vaultAndStrip } = require('./_event-pii');
const { isAuthorized } = require('./_admin-auth');

// 2026-10-22: this used to be an OPEN read/write proxy to events.json using the
// site's GitHub token — anyone could overwrite the file. It now requires an
// admin session token (owner or events_staff, same as save-events) in the
// x-admin-token header. Only known caller: the stray old admin copy at
// nextjs/src/app/careers/quarry-admin.html (the live admin uses save-events).

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const DATA_FILE = 'events.json';

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
        'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (!isAuthorized(event, null, ['events_staff'])) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Admin session required' }) };
    }

    if (!GITHUB_TOKEN) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'GitHub token not configured' })
        };
    }

    const githubUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`;

    try {
        if (event.httpMethod === 'GET') {
            const resp = await fetch(githubUrl, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            if (!resp.ok) {
                const err = await resp.text();
                return { statusCode: resp.status, headers, body: err };
            }
            const data = await resp.json();
            return { statusCode: 200, headers, body: JSON.stringify(data) };

        } else if (event.httpMethod === 'PUT') {
            const body = JSON.parse(event.body);
            // 2026-10-22: vault + strip buyer PII before committing to the public repo.
            let content = body.content;
            try {
                const doc = JSON.parse(Buffer.from(String(content || ''), 'base64').toString('utf8'));
                await vaultAndStrip(doc, 'github-proxy');
                content = Buffer.from(JSON.stringify(doc, null, 2), 'utf8').toString('base64');
            } catch (e) {
                return { statusCode: 503, headers, body: JSON.stringify({ error: 'Not saved: ' + e.message }) };
            }
            const resp = await fetch(githubUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/vnd.github.v3+json'
                },
                body: JSON.stringify({
                    message: body.message || 'Update events data',
                    content,
                    sha: body.sha
                })
            });
            const result = await resp.json();
            if (!resp.ok) {
                return { statusCode: resp.status, headers, body: JSON.stringify(result) };
            }
            return { statusCode: 200, headers, body: JSON.stringify(result) };
        }

        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
};
