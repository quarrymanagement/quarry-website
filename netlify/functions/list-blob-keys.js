// Diagnostic: list all blob keys for a given store (or default store if no name).
// GET /.netlify/functions/list-blob-keys?adminPassword=...&store=golf-bookings
const crypto = require('crypto');
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const NETLIFY_TOKEN = process.env.NETLIFY_AUTH_TOKEN || '';
const SITE_ID = 'roaring-pegasus-444826';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function checkAdmin(p) {
  if (!p) return false;
  if (ADMIN_PASSWORD_HASH) return sha256(p) === ADMIN_PASSWORD_HASH;
  return p === 'quarry2026';
}
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const q = event.queryStringParameters || {};
  if (!checkAdmin(q.adminPassword)) return reply(401, { ok: false, error: 'auth' });
  // Probe a specific key across multiple path variants
  const key = q.key || 'golf-2026-05-10';
  const urls = [
    // Flat-key variants
    `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${encodeURIComponent(key)}`,
    `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${key}`,
    // Store-namespaced variants
    `https://api.netlify.com/api/v1/blobs/${SITE_ID}/site/${encodeURIComponent(key)}`,
    `https://api.netlify.com/api/v1/blobs/${SITE_ID}/golf-bookings/${encodeURIComponent(key.replace(/^golf-/, ''))}`,
    `https://api.netlify.com/api/v1/blobs/${SITE_ID}/golf/${encodeURIComponent(key.replace(/^golf-/, ''))}`,
  ];
  const results = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + NETLIFY_TOKEN } });
      const text = await r.text();
      results.push({ url, status: r.status, bodyHead: text.slice(0, 600) });
    } catch (e) {
      results.push({ url, error: e.message });
    }
  }
  return reply(200, { ok: true, key, results });
};
