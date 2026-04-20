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

// Fetch file content via the Git Blobs API (always returns fresh content, never cached)
async function fetchBlobContent(repo, blobSha, token) {
  const res = await githubRequest('GET', '/repos/' + repo + '/git/blobs/' + blobSha, token);
  if (res.statusCode === 200 && res.data.content) {
    return Buffer.from(res.data.content, 'base64').toString('utf-8');
  }
  throw new Error('Could not fetch blob: ' + res.statusCode);
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

    // Get file metadata — this gives us the SHA (always fresh from GitHub API)
    const metaRes = await githubRequest('GET', `/repos/${repo}/contents/${filePath}`, token);
    let fileSha = '';
    let blobSha = '';
    if (metaRes.statusCode === 200 && metaRes.data.sha) {
      fileSha = metaRes.data.sha;
      blobSha = metaRes.data.sha;
    }

    // Fetch current file content via Blobs API (no caching, always up-to-date)
    let currentData = null;
    if (blobSha) {
      try {
        const rawContent = await fetchBlobContent(repo, blobSha, token);
        currentData = JSON.parse(rawContent);
      } catch (e) {
        console.log('Could not fetch blob, trying content field:', e.message);
        // Fallback: if blob was small enough, content might be in metaRes
        if (metaRes.data.content && metaRes.data.encoding === 'base64') {
          currentData = JSON.parse(Buffer.from(metaRes.data.content, 'base64').toString('utf-8'));
        }
      }
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

    console.log('Image map built with', Object.keys(currentImageMap).length, 'images');

    // Re-attach images to incoming events if they were stripped
    if (incomingData.events) {
      incomingData.events.forEach(evt => {
        if (!evt.image && evt.id && currentImageMap[evt.id]) {
          evt.image = currentImageMap[evt.id];
          console.log('Re-attached image for event:', evt.id);
        }
      });
    }

    // Preserve registrations from current file if not included or empty in incoming
    if (currentData && currentData.registrations) {
      if (!incomingData.registrations || Object.keys(incomingData.registrations).length === 0) {
        incomingData.registrations = currentData.registrations;
      } else {
        // Merge: keep any registration arrays from current that aren't in incoming
        Object.keys(currentData.registrations).forEach(key => {
          if (!incomingData.registrations[key]) {
            incomingData.registrations[key] = currentData.registrations[key];
          }
        });
      }
    }

    const content = JSON.stringify(incomingData, null, 2);
    const encoded = Buffer.from(content, 'utf-8').toString('base64');

    // Push update
    const putData = {
      message: 'Update events.json from admin panel',
      content: encoded,
    };
    if (fileSha) putData.sha = fileSha;

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
