// list-blob-keys.js — admin diagnostic to list keys in a Netlify Blobs store.
// GET /.netlify/functions/list-blob-keys?adminPassword=...&store=golf-bookings&prefix=2026
// Migrated to SDK-backed listing — see _blobs.js for context on the prior
// silently-failing direct REST calls.
const crypto = require('crypto');
const { listKeys } = require('./_blobs');

const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

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

  const store = q.store || 'golf-bookings';
  const prefix = q.prefix || '';
  const keys = await listKeys(store, prefix);
  return reply(200, { ok: true, store, prefix, count: keys.length, keys });
};
