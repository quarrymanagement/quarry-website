const crypto = require('crypto');
const https = require('https');

const ADMIN_PASSWORD_HASH    = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_SESSION_SECRET   = process.env.ADMIN_SESSION_SECRET || '';
const SESSION_TTL_HOURS      = 168; // 7 days — must match verify-admin-password.js

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }

function checkPassword(p) {
  if (!p) return false;
  if (ADMIN_PASSWORD_HASH) return sha256(p) === ADMIN_PASSWORD_HASH;
  return p === 'quarry2026';
}
function checkToken(token) {
  if (!ADMIN_SESSION_SECRET || !token) return false;
  const [issued, sig] = String(token).split('.');
  if (!issued || !sig) return false;
  if (hmac(issued, ADMIN_SESSION_SECRET) !== sig) return false;
  const ageHours = (Date.now() - parseInt(issued, 10)) / (1000 * 3600);
  return ageHours < SESSION_TTL_HOURS;
}
function checkAdmin({ password, token }) {
  if (token && checkToken(token)) return true;
  if (password && checkPassword(password)) return true;
  return false;
}

// Whitelist: only files the admin panel is allowed to write
const ALLOWED_FILES = new Set([
  'menu.json',
  'rewards.json',
  'app-content.json',
  'events.json',
  'forms.json',
  'crm-notes.json',
  'schedule.json',
  'members.json',     // rewards-members tab edits
  'subscribers.json', // newsletter signups
]);

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

        const { filePath, content, message, adminPassword, adminToken } = JSON.parse(event.body);
        if (!checkAdmin({ password: adminPassword, token: adminToken })) {
            return { statusCode: 401, headers, body: JSON.stringify({ error: 'Admin auth required (adminPassword or adminToken)' }) };
        }
        if (!filePath || !content) throw new Error('filePath and content are required');
        if (!ALLOWED_FILES.has(String(filePath).trim())) {
            return { statusCode: 403, headers, body: JSON.stringify({ error: 'filePath not in allow-list: ' + filePath }) };
        }

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
