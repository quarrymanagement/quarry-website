const https = require('https');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const response = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

const handleOptions = () => response(200, { message: 'OK' });

// GitHub API helper
const githubRequest = (method, path, token, data = null) => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'Quarry-Admin-Panel',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
};

// Fetch large file content via raw.githubusercontent.com
function fetchRawFile(repo, filePath) {
  return new Promise((resolve, reject) => {
    https.get('https://raw.githubusercontent.com/' + repo + '/main/' + filePath, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return response(500, { error: 'GitHub token not configured on server' });
  }

  const repo = 'quarrymanagement/quarry-website';
  const filePath = 'events.json';

  try {
    const incomingData = JSON.parse(event.body);

    // Fetch current events.json from GitHub (handles large files via raw URL)
    let currentData = null;
    try {
      const rawContent = await fetchRawFile(repo, filePath);
      currentData = JSON.parse(rawContent);
    } catch (e) {
      console.log('Could not fetch current file, will create fresh:', e.message);
    }

    // Build image map from current file (so we don't lose images stripped by admin)
    const currentImageMap = {};
    if (currentData && currentData.events) {
      currentData.events.forEach(evt => {
        if (evt.id && evt.image) {
          currentImageMap[evt.id] = evt.image;
        }
      });
    }

    // Re-attach images to incoming events if they were stripped
    if (incomingData.events) {
      incomingData.events.forEach(evt => {
        if (!evt.image && evt.id && currentImageMap[evt.id]) {
          evt.image = currentImageMap[evt.id];
        }
      });
    }

    // Preserve registrations from current file if not included in incoming
    if (!incomingData.registrations && currentData && currentData.registrations) {
      incomingData.registrations = currentData.registrations;
    }

    const content = JSON.stringify(incomingData, null, 2);
    const encoded = Buffer.from(content, 'utf-8').toString('base64');

    // Get current file SHA
    const shaRes = await githubRequest('GET', `/repos/${repo}/contents/${filePath}`, token);
    let sha = '';
    if (shaRes.statusCode === 200 && shaRes.data.sha) {
      sha = shaRes.data.sha;
    }

    // Push update
    const putData = {
      message: 'Update events.json from admin panel',
      content: encoded,
    };
    if (sha) putData.sha = sha;

    const putRes = await githubRequest('PUT', `/repos/${repo}/contents/${filePath}`, token, putData);

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      return response(200, { success: true, message: 'Saved to GitHub' });
    } else {
      return response(putRes.statusCode, { error: putRes.data.message || 'GitHub save failed' });
    }
  } catch (err) {
    console.error('Save error:', err);
    return response(500, { error: err.message || 'Internal server error' });
  }
};
