const https = require('https');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function githubRequest(method, path, token, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'Quarry-Forms',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ statusCode: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'GitHub token not configured' }) };

  const repo = 'quarrymanagement/quarry-website';

  try {
    const incoming = JSON.parse(event.body);
    // incoming = { forms: [...] } — just the form definitions (no submissions)

    // Fetch current forms.json to preserve submissions
    let currentData = { forms: [], submissions: {} };
    try {
      const metaRes = await githubRequest('GET', '/repos/' + repo + '/contents/forms.json', ghToken);
      if (metaRes.statusCode === 200 && metaRes.data.sha) {
        if (metaRes.data.content && metaRes.data.encoding === 'base64') {
          currentData = JSON.parse(Buffer.from(metaRes.data.content, 'base64').toString('utf-8'));
        } else {
          currentData = JSON.parse(await fetchRaw('https://raw.githubusercontent.com/' + repo + '/main/forms.json'));
        }
      }
    } catch (e) {
      console.log('No existing forms.json, creating fresh');
    }

    // Replace form definitions, preserve submissions
    const merged = {
      forms: incoming.forms || [],
      submissions: currentData.submissions || {}
    };

    const encoded = Buffer.from(JSON.stringify(merged, null, 2), 'utf-8').toString('base64');

    // Get SHA
    const metaRes = await githubRequest('GET', '/repos/' + repo + '/contents/forms.json', ghToken);
    const sha = (metaRes.statusCode === 200 && metaRes.data.sha) ? metaRes.data.sha : '';

    const putData = { message: 'Update forms from admin panel', content: encoded };
    if (sha) putData.sha = sha;

    const putRes = await githubRequest('PUT', '/repos/' + repo + '/contents/forms.json', ghToken, putData);

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    } else {
      return { statusCode: putRes.statusCode, headers: HEADERS, body: JSON.stringify({ error: putRes.data.message || 'Save failed' }) };
    }
  } catch (err) {
    console.error('Save forms error:', err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
