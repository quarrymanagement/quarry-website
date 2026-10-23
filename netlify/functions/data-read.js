// ============================================================================
// data-read.js — the one read path for repo data files from browsers.
//
// GET /.netlify/functions/data-read?file=events.json
//
// Returns the file's JSON body exactly as raw.githubusercontent.com did, so
// callers only swap the URL. Reads go through the GitHub API with
// GITHUB_TOKEN, so this keeps working once the repo is PRIVATE, and data
// stays live without a rebuild (≈30 s CDN cache).
//
//   PUBLIC_FILES    — readable by anyone (no PII). Cached at the edge.
//   PROTECTED_FILES — customer/member PII (see PUBLIC_VIEWS for forms.json). Require an admin session token
//                     (x-admin-token header, same scheme as _admin-auth.js).
//                     Never cached.
// Anything else → 404. Writes still go through data-store / save-github-file.
//
// &nocache=<anything> + a valid session token → skips every cache (admin
// panels re-reading right after a save). Without a token it is ignored for
// the instance cache, so anonymous callers can't burn the GitHub rate limit.
// ============================================================================
const { readRepoText } = require('./_github-data');
const { isAuthorized } = require('./_admin-auth');

const PUBLIC_FILES = new Set([
  'events.json',        // PII vaulted/stripped since 2026-10-22 (_event-pii.js)
  'menu.json',
  'rewards.json',
  'app-content.json',
  'wine_tastings.json',
  // schedule.json: staff names/emails/phones. schedule.html does its
  // email+last-name login client-side BEFORE any token exists, so it must
  // stay anonymous-readable for now (same exposure as today). Follow-up:
  // move that login server-side and move this file to PROTECTED_FILES.
  'schedule.json',
]);

// value = staff roles allowed in addition to the owner token
const PROTECTED_FILES = {
  'subscribers.json': ['events_staff'],
  'forms.json': ['events_staff'],
  'food-truck-leads.json': ['events_staff'],
  'members.json': [],
  'reservations.json': ['events_staff'],
  'scanned-flagged.json': [],
};

// Protected files that have a PII-free public projection. Unauthenticated
// callers get the projection (edge-cached); a valid session gets the full file.
//   forms.json → { forms } only (public quarry-form.html needs the form
//   definitions; submissions stay behind the session check).
const PUBLIC_VIEWS = {
  'forms.json': (doc) => ({ forms: (doc && doc.forms) || [] }),
};

const BASE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  'Content-Type': 'application/json; charset=utf-8',
};

const ANY_SESSION_ROLES = ['events_staff', 'server_lead'];

const err = (statusCode, error) => ({
  statusCode,
  headers: { ...BASE_HEADERS, 'Cache-Control': 'no-store' },
  body: JSON.stringify({ error }),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: BASE_HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return err(405, 'Method not allowed');

  const q = event.queryStringParameters || {};
  const file = (q.file || '').trim();
  const isPublic = PUBLIC_FILES.has(file);
  const isProtected = Object.prototype.hasOwnProperty.call(PROTECTED_FILES, file);
  if (!isPublic && !isProtected) return err(404, 'Unknown file');
  const view = isProtected && !isAuthorized(event, null, PROTECTED_FILES[file]) ? PUBLIC_VIEWS[file] : null;
  if (isProtected && !view && !isAuthorized(event, null, PROTECTED_FILES[file])) {
    return err(401, 'Admin session required');
  }

  const fresh = !!q.nocache && isAuthorized(event, null, ANY_SESSION_ROLES);

  try {
    let text = await readRepoText(file, { fresh });
    if (view) text = JSON.stringify(view(JSON.parse(text)));
    const headers = { ...BASE_HEADERS };
    if ((isPublic || view) && !q.nocache) {
      // Browser 15 s; Netlify edge 30 s + serve-stale while refreshing.
      // Cache key = ?file= only, so cache-busting ?t= params don't defeat it.
      headers['Cache-Control'] = 'public, max-age=15';
      headers['Netlify-CDN-Cache-Control'] = 'public, s-maxage=30, stale-while-revalidate=120';
      headers['Netlify-Vary'] = 'query=file|nocache';
    } else {
      headers['Cache-Control'] = 'private, no-store';
    }
    return { statusCode: 200, headers, body: text };
  } catch (e) {
    const status = e.status === 404 ? 404 : 502;
    return err(status, status === 404 ? 'File not found' : 'Upstream read failed');
  }
};
