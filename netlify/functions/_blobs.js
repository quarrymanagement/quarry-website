// ============================================================================
// _blobs.js — shared Netlify Blobs helper
//
// Prior code in this codebase hit `https://api.netlify.com/api/v1/blobs/...`
// directly with the NETLIFY_AUTH_TOKEN. That endpoint is the LIST/admin API
// and does NOT accept PUT writes from external code — writes silently 404 and
// reads returned empty container listings, so every golf-booking persist call
// silently failed. (See setup doc + REVERT commits 001615c, 6764e1e, ff27489.)
//
// The correct path is the official @netlify/blobs SDK, which auto-detects
// runtime context inside Netlify Functions (no manual auth/site-ID needed),
// and falls back to explicit NETLIFY_AUTH_TOKEN + NETLIFY_SITE_ID for
// out-of-context use (cron, local dev).
//
// Public API matches the pre-existing readBlob/writeBlob signatures so the
// migration across ~17 functions is a one-line swap each:
//   const { readBlob, writeBlob } = require('./_blobs');
//
// Path convention: "store/key" is split on the first slash. A path with no
// slash uses the default "kv" store, matching how single-key blobs were used.
// Filenames starting with `_` are excluded from Netlify Functions deployment,
// so this file is a helper module only — not a callable endpoint.
// ============================================================================

const { getStore } = require('@netlify/blobs');

const SITE_ID_FALLBACK = process.env.NETLIFY_SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';

function parsePath(path) {
  const idx = String(path || '').indexOf('/');
  if (idx === -1) return { store: 'kv', key: String(path || '') };
  return { store: String(path).slice(0, idx), key: String(path).slice(idx + 1) };
}

function storeFor(name) {
  // When running inside a Netlify Function the runtime injects auth + site
  // automatically and the no-arg form works. Outside that context (some cron
  // runners, local dev) we pass siteID + token explicitly.
  try {
    return getStore(name);
  } catch (_) {
    return getStore({
      name,
      siteID: SITE_ID_FALLBACK,
      token: process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_BLOBS_TOKEN || '',
    });
  }
}

async function readBlob(path) {
  const { store, key } = parsePath(path);
  try {
    const value = await storeFor(store).get(key, { type: 'json' });
    return value || null;
  } catch (e) {
    console.error('readBlob error', path, e.message);
    return null;
  }
}

async function writeBlob(path, data) {
  const { store, key } = parsePath(path);
  try {
    await storeFor(store).setJSON(key, data);
    return true;
  } catch (e) {
    console.error('writeBlob error', path, e.message);
    return false;
  }
}

async function deleteBlob(path) {
  const { store, key } = parsePath(path);
  try {
    await storeFor(store).delete(key);
    return true;
  } catch (e) {
    console.error('deleteBlob error', path, e.message);
    return false;
  }
}

async function listKeys(storeName, prefix) {
  try {
    const out = [];
    const iter = storeFor(storeName).list({ prefix: prefix || undefined });
    for await (const page of iter) {
      for (const b of page.blobs) out.push(b.key);
    }
    return out;
  } catch (e) {
    console.error('listKeys error', storeName, e.message);
    return [];
  }
}

module.exports = { readBlob, writeBlob, deleteBlob, listKeys, storeFor, parsePath };
