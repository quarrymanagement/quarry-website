// ============================================================================
// upload-event-image.js  —  Netlify Function
//
// Stores an event image as a FILE in the repo and returns its path, instead of
// letting the admin panel embed the whole image inside events.json as a base64
// data URL.
//
// Why this exists: two events once carried 5.8 MB of base64 image data, which
// pushed events.json to ~6 MB — about 140 KB under Netlify's 6,291,456-byte
// function request limit. Saving events silently stopped working. events.json is
// back down to ~99 KB and must stay there, so images now live in
// assets/img/events/ and events.json only holds the path.
//
// Auth is the admin session token, verified with the SAME code as
// netlify/functions/save-events.js. If you change one, change the other.
// ============================================================================

const https = require('https');
const crypto = require('crypto');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
};

const response = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

const handleOptions = () => response(200, { message: 'OK' });

// Same secret derivation as netlify/functions/verify-admin-password.js, so the
// token minted at login verifies here. Keep the two in sync.
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const SESSION_TTL_HOURS = 168;

function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }

function isAuthorized(event, body) {
  const supplied =
    (event.headers && (event.headers['x-admin-token'] || event.headers['X-Admin-Token'])) ||
    (body && body.adminToken) || '';
  if (!supplied || !SESSION_SECRET) return false;
  const parts = String(supplied).split('.');
  if (parts.length !== 2) return false;
  const [issued, sig] = parts;
  if (!/^\d+$/.test(issued)) return false;
  const expected = hmac(issued, SESSION_SECRET);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return false;
  const ageHours = (Date.now() - parseInt(issued, 10)) / (1000 * 3600);
  return ageHours < SESSION_TTL_HOURS;
}

// GitHub API helper (same shape as save-events.js)
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

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
};

const MAX_BYTES = 4 * 1024 * 1024; // ~4 MB decoded

// filename -> "spring-fling-poster". Lowercase, non-alphanumerics collapsed to
// a single dash, trimmed, capped at 50 chars.
function slugify(name) {
  return String(name || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return response(500, { error: 'GitHub token not configured on server' });

  const repo = 'quarrymanagement/quarry-website';

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return response(400, { error: 'Invalid JSON body' });
  }

  // ---- AUTH GATE ---------------------------------------------------------
  if (!isAuthorized(event, body)) {
    return response(401, { error: 'Unauthorized. Admin token required to upload images.' });
  }

  const dataUrl = body.dataUrl || '';
  const match = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(String(dataUrl).trim());
  if (!match) {
    return response(400, { error: 'Expected dataUrl in the form data:image/png;base64,....' });
  }

  const mime = match[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) {
    return response(400, { error: 'Unsupported image type: ' + mime + '. Use PNG, JPEG or WebP.' });
  }

  const base64 = match[2].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return response(400, { error: 'Image data is not valid base64.' });
  }

  // Decoded size, without actually allocating the buffer twice.
  const padding = (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  const decodedBytes = Math.floor(base64.length * 3 / 4) - padding;
  if (decodedBytes > MAX_BYTES) {
    return response(413, {
      error: 'That image is ' + (decodedBytes / 1048576).toFixed(1) +
             ' MB. Please use a smaller image (under 4 MB) — resize or re-export it and try again.'
    });
  }

  // ---- SAFE PATH ---------------------------------------------------------
  const slug = slugify(body.filename) || 'event-image';
  const stamp = Date.now().toString(36).slice(-6);
  const fileName = slug + '-' + stamp + '.' + ext;
  const filePath = 'assets/img/events/' + fileName;

  // Belt and braces: nothing derived above can escape the folder, but check.
  if (filePath.indexOf('..') !== -1 || !/^assets\/img\/events\/[a-z0-9][a-z0-9-]*\.(png|jpg|webp)$/.test(filePath)) {
    return response(400, { error: 'Could not derive a safe filename from ' + (body.filename || '(none)') });
  }

  try {
    // Include sha only if the path already exists (it almost never will, given
    // the timestamp suffix).
    let sha = '';
    const metaRes = await githubRequest('GET', `/repos/${repo}/contents/${filePath}`, token);
    if (metaRes.statusCode === 200 && metaRes.data && metaRes.data.sha) sha = metaRes.data.sha;

    // Pass the base64 straight through. Decoding to a string here would corrupt
    // the image bytes.
    const putData = {
      message: 'Add event image ' + fileName + ' via admin panel',
      content: base64,
    };
    if (sha) putData.sha = sha;

    const putRes = await githubRequest('PUT', `/repos/${repo}/contents/${filePath}`, token, putData);

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      return response(200, { ok: true, path: '/' + filePath });
    }
    return response(putRes.statusCode, {
      error: (putRes.data && putRes.data.message) || 'GitHub upload failed'
    });
  } catch (err) {
    console.error('Image upload error:', err);
    return response(500, { error: err.message || 'Internal server error' });
  }
};
