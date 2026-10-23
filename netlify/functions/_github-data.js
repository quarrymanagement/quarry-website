// ============================================================================
// _github-data.js — authenticated reads of repo data files (import-only).
//
// Replaces every anonymous raw.githubusercontent.com read so the repo can be
// made PRIVATE. Uses the GitHub contents API with GITHUB_TOKEN and the raw
// media type (works for files up to 100 MB, no base64 / 1 MB limit).
//
// A small per-instance cache + ETag revalidation keeps GitHub API usage low:
// conditional requests that return 304 don't count against the rate limit.
//
//   const { readRepoText, readRepoJson } = require('./_github-data');
//   const events = await readRepoJson('events.json');          // parsed
//   const txt    = await readRepoText('forms.json');           // string
//   await readRepoJson('x.json', { fresh: true })               // skip cache
//
// Throws an Error with .status on non-200 (404 => .status === 404).
// ============================================================================
const https = require('https');

const GITHUB_REPO = 'quarrymanagement/quarry-website';
const BRANCH = 'main';
const CACHE_MS = 15 * 1000;
const cache = new Map(); // file -> { text, etag, at }

function ghRaw(file, etag) {
  const token = process.env.GITHUB_TOKEN || '';
  if (!token) return Promise.reject(Object.assign(new Error('GITHUB_TOKEN not configured'), { status: 500 }));
  const path = '/repos/' + GITHUB_REPO + '/contents/' +
    file.split('/').map(encodeURIComponent).join('/') + '?ref=' + BRANCH;
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github.raw',
      'User-Agent': 'Quarry-Data-Read',
    };
    if (etag) headers['If-None-Match'] = etag;
    const req = https.request({ hostname: 'api.github.com', path, method: 'GET', headers, timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, etag: res.headers.etag || null, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('GitHub read timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function readRepoText(file, opts) {
  const fresh = !!(opts && opts.fresh);
  const hit = cache.get(file);
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.text;
  const r = await ghRaw(file, hit && hit.etag);
  if (r.status === 304 && hit) { hit.at = Date.now(); return hit.text; }
  if (r.status !== 200) {
    throw Object.assign(new Error('GitHub read ' + file + ': HTTP ' + r.status), { status: r.status });
  }
  cache.set(file, { text: r.text, etag: r.etag, at: Date.now() });
  return r.text;
}

async function readRepoJson(file, opts) {
  return JSON.parse(await readRepoText(file, opts));
}

module.exports = { readRepoText, readRepoJson, GITHUB_REPO };
