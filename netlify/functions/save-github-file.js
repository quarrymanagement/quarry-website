const https = require('https');

function githubRequest(method, path, token, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: path,
            method: method,
            headers: {
                'Authorization': `token ${token}`,
                'User-Agent': 'Quarry-Admin-Panel',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch (e) { resolve({ status: res.statusCode, data: data }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const token = process.env.GITHUB_TOKEN;
        if (!token) throw new Error('GITHUB_TOKEN not configured');

        const { filePath, content, message } = JSON.parse(event.body);
        if (!filePath || !content) throw new Error('filePath and content are required');

        const repo = 'quarrymanagement/quarry-website';
        const commitMsg = message || `Update ${filePath} from admin panel`;

        // Get current file SHA (if it exists)
        let sha = null;
        try {
            const getRes = await githubRequest('GET', `/repos/${repo}/contents/${filePath}`, token);
            if (getRes.status === 200 && getRes.data.sha) {
                sha = getRes.data.sha;
            }
        } catch (e) { /* file may not exist yet */ }

        // Encode content to base64
        const encoded = Buffer.from(content, 'utf-8').toString('base64');

        const putData = { message: commitMsg, content: encoded };
        if (sha) putData.sha = sha;

        const putRes = await githubRequest('PUT', `/repos/${repo}/contents/${filePath}`, token, putData);

        if (putRes.status === 200 || putRes.status === 201) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, message: `Updated ${filePath}` }),
            };
        } else {
            throw new Error(`GitHub API returned ${putRes.status}: ${JSON.stringify(putRes.data)}`);
        }
    } catch (err) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: err.message }),
        };
    }
};
