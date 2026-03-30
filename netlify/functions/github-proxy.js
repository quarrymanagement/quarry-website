const fetch = require('node-fetch');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const DATA_FILE = 'events.json';

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
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
            const resp = await fetch(githubUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/vnd.github.v3+json'
                },
                body: JSON.stringify({
                    message: body.message || 'Update events data',
                    content: body.content,
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
