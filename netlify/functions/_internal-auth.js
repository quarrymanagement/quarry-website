// ============================================================================
// _internal-auth.js — shared secret for server-to-server calls (import-only).
//
// Netlify functions that call other functions over HTTP (data-store, etc.)
// send   x-quarry-key: <internalKey()>   via internalHeaders().
// The key is QUARRY_DATA_KEY when that env var is set; otherwise it is derived
// from GITHUB_TOKEN (already present in every deploy context), so no new env
// var is required and the raw token is never sent over the wire.
// ============================================================================
const crypto = require('crypto');

function internalKey() {
  if (process.env.QUARRY_DATA_KEY) return process.env.QUARRY_DATA_KEY;
  const gh = process.env.GITHUB_TOKEN || '';
  if (!gh) return '';
  return crypto.createHmac('sha256', gh).update('quarry-internal-v1', 'utf8').digest('hex');
}

function internalHeaders(extra) {
  return Object.assign({ 'x-quarry-key': internalKey() }, extra || {});
}

function isInternal(event) {
  const h = (event && event.headers) || {};
  const got = String(h['x-quarry-key'] || h['X-Quarry-Key'] || '');
  const want = internalKey();
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

module.exports = { internalKey, internalHeaders, isInternal };
