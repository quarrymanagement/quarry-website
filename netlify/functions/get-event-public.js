// ============================================================================
// get-event-public.js
//
// Returns a single event by id or slug — meant for fast detail-page loads
// (the full events.json is ~6MB so we can't ship that to every visitor).
//
// Reads events.json via the GitHub contents API (_github-data) (the build pipeline writes
// here) and filters to the requested event. Response is cached at CDN edge
// for 60 seconds and at the browser for 5 minutes.
//
// Query params:  ?id=<slug-or-id>
// Response:      { event: {...} }  or  { error: 'Not found' }
// 2026-10-22: registrations are returned WITHOUT name/email/phone (sanitizeEvent);
// the public pages only need qty/seating to count seats.
// ============================================================================

const https = require('https');
const { sanitizeEvent, isDraftEvent } = require('./_event-pii');
const { readRepoText, readRepoJson } = require('./_github-data');
const { activeBundles } = require('./_event-bundles');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'quarry-event-detail' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    // Cache 60s at CDN, 5min in browser - events rarely change for active items
    'Cache-Control': 'public, max-age=300, s-maxage=60',
    'Netlify-CDN-Cache-Control': 'public, max-age=60'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const want = (event.queryStringParameters && (event.queryStringParameters.id || event.queryStringParameters.slug)) || '';
  if (!want) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'id required' }) };
  }

  try {
    // Authenticated GitHub read (works with a private repo) — bypasses the 6MB Netlify-served events.json
    const data = await readRepoJson('events.json');
    const events = (data && data.events) || [];
    const found = events.find(function(e) {
      return e.id === want || e.slug === want;
    });
    // 2026-10-28: hidden (draft) events answer exactly like a missing id.
    if (!found || isDraftEvent(found)) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event not found' }) };
    }
    const out = sanitizeEvent(found);
    // 2026-10-26: limited-time bundles that are on sale right now (computed per
    // request, so an expired deal drops out within the 60s CDN cache).
    const bundles = activeBundles(found);
    if (bundles.length) out.activeBundles = bundles;
    return { statusCode: 200, headers, body: JSON.stringify({ event: out }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
