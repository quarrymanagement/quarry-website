// ============================================================================
// get-event-public.js
//
// Returns a single event by id or slug — meant for fast detail-page loads
// (the full events.json is ~6MB so we can't ship that to every visitor).
//
// Reads events.json from raw.githubusercontent.com (the build pipeline writes
// here) and filters to the requested event. Response is cached at CDN edge
// for 60 seconds and at the browser for 5 minutes.
//
// Query params:  ?id=<slug-or-id>
// Response:      { event: {...} }  or  { error: 'Not found' }
// ============================================================================

const https = require('https');

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
    // Pull from GitHub raw — bypasses the 6MB Netlify-served events.json
    const data = await fetchJSON('https://raw.githubusercontent.com/quarrymanagement/quarry-website/main/events.json');
    const events = (data && data.events) || [];
    const found = events.find(function(e) {
      return e.id === want || e.slug === want;
    });
    if (!found) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event not found' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ event: found }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
