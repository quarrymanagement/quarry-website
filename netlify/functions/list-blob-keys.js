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
  // First — diagnose actual site UUID from Netlify env + API
  const envSiteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
  let resolvedFromAPI = '';
  try {
    const r = await fetch('https://api.netlify.com/api/v1/sites?name=roaring-pegasus-444826', {
      headers: { Authorization: 'Bearer ' + NETLIFY_TOKEN },
    });
    const arr = await r.json();
    if (Array.isArray(arr) && arr.length) {
      resolvedFromAPI = arr[0].id || '';
    } else if (arr && arr.id) {
      resolvedFromAPI = arr.id;
    }
  } catch (_) {}
  const useId = envSiteId || resolvedFromAPI || SITE_ID;
  // Probe a specific key across multiple path variants
  const key = q.key || 'golf-2026-05-10';
  const urls = [
    // Flat-key variants using resolved UUID
    `https://api.netlify.com/api/v1/blobs/${useId}/${encodeURIComponent(key)}`,
    `https://api.netlify.com/api/v1/blobs/${useId}/site/${encodeURIComponent(key)}`,
    `https://api.netlify.com/api/v1/blobs/${useId}/golf-bookings/${encodeURIComponent(key.replace(/^golf-/, ''))}`,
    // Original slug-based (will 400 — for comparison)
    `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${encodeURIComponent(key)}`,
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
  return reply(200, { ok: true, key, envSiteId, resolvedFromAPI, useId, results });
};
