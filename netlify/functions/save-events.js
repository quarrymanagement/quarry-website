// ============================================================================
// save-events.js  —  Netlify Function
//
// Writes events.json back to GitHub on behalf of the admin panel.
//
// 2026-07-31 hardening (two fixes):
//
//   1. AUTHENTICATION. This endpoint previously accepted an unauthenticated
//      POST from anywhere on the internet and overwrote the entire events.json.
//      It now requires the admin SESSION TOKEN minted at login, supplied either
//      as the `x-admin-token` header or as `adminToken` in the JSON body.
//
//      The token is "<issuedMs>.<hmacSha256(issuedMs, SESSION_SECRET)>", issued
//      by netlify/functions/verify-admin-password.js after a successful password
//      check. We re-verify the HMAC here using the same secret derivation and
//      reject anything malformed or older than SESSION_TTL_HOURS. No static or
//      plaintext password is accepted any more.
//
//   2. REGISTRATION PRESERVATION (per-event). The admin panel uploads whatever
//      snapshot of events.json its browser happens to be holding. If a Square
//      payment lands after the panel was loaded, that sale is written into the
//      live file by the webhook and then silently erased by the next admin save.
//
//      The old code guarded only the legacy TOP-LEVEL `registrations` map. Since
//      June 2026 the Square webhook writes into a PER-EVENT `events[].registrations[]`
//      array, which had no protection at all.
//
//      We now re-read the live file and merge, per event, any registration whose
//      paymentId is missing from the incoming payload, then recompute
//      registeredCount / registered. An event that exists live WITH paid
//      registrations and is absent from the incoming payload is preserved rather
//      than deleted — a stale browser tab must never be able to drop a paid sale.
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

// GitHub API helper
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

// Fetch file content via the Git Blobs API (always returns fresh content, never cached)
async function fetchBlobContent(repo, blobSha, token) {
  const res = await githubRequest('GET', '/repos/' + repo + '/git/blobs/' + blobSha, token);
  if (res.statusCode === 200 && res.data.content) {
    return Buffer.from(res.data.content, 'base64').toString('utf-8');
  }
  throw new Error('Could not fetch blob: ' + res.statusCode);
}

// Sum a registrations array the same way the Square webhook does, so the two
// always agree on what registeredCount means.
function sumRegistrations(regs) {
  return (regs || []).reduce(function (s, r) {
    return s + (Number(r.qty) || Number(r.tickets) || 1);
  }, 0);
}

/**
 * Merge per-event registrations from the live file into the incoming payload.
 *
 * Returns a small report so the save response can tell the admin what was
 * rescued — silence here would defeat the purpose.
 */
function mergeEventRegistrations(incomingData, currentData) {
  const report = { rescuedRegistrations: 0, rescuedEvents: [], preservedEvents: [] };
  if (!currentData || !Array.isArray(currentData.events)) return report;
  if (!Array.isArray(incomingData.events)) return report;

  const incomingById = {};
  incomingData.events.forEach(function (evt) {
    if (evt && evt.id) incomingById[evt.id] = evt;
  });

  currentData.events.forEach(function (liveEvt) {
    if (!liveEvt || !liveEvt.id) return;
    const liveRegs = Array.isArray(liveEvt.registrations) ? liveEvt.registrations : [];
    const target = incomingById[liveEvt.id];

    // Case 1: the incoming payload dropped this event entirely. If it has paid
    // registrations, put it back — a stale tab must not be able to delete money.
    if (!target) {
      if (liveRegs.length > 0) {
        incomingData.events.push(liveEvt);
        report.preservedEvents.push(liveEvt.name || liveEvt.id);
      }
      return;
    }

    // Case 2: event is present in both — union the registrations by paymentId.
    if (liveRegs.length === 0) return;
    target.registrations = Array.isArray(target.registrations) ? target.registrations : [];

    const seen = {};
    target.registrations.forEach(function (r) {
      if (r && r.paymentId) seen[r.paymentId] = true;
    });

    let rescued = 0;
    liveRegs.forEach(function (r) {
      if (!r) return;
      // No paymentId (legacy/manual rows): fall back to a composite key so we
      // neither duplicate nor drop them.
      const key = r.paymentId || [r.email, r.registeredAt, r.qty].join('|');
      if (!seen[key]) {
        target.registrations.push(r);
        seen[key] = true;
        rescued++;
      }
    });

    if (rescued > 0) {
      report.rescuedRegistrations += rescued;
      report.rescuedEvents.push((target.name || target.id) + ' (+' + rescued + ')');
    }

    // Recompute counts from the merged array so the totals can never drift.
    const total = sumRegistrations(target.registrations);
    target.registeredCount = total;
    target.registered = total;
    if (target.totalCapacity && total >= target.totalCapacity) target.status = 'sold-out';
  });

  return report;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return response(500, { error: 'GitHub token not configured on server' });
  }

  const repo = 'quarrymanagement/quarry-website';
  const filePath = 'events.json';

  try {
    const incomingData = JSON.parse(event.body);

    // ---- AUTH GATE -------------------------------------------------------
    if (!isAuthorized(event, incomingData)) {
      return response(401, { error: 'Unauthorized. Admin token required to save events.' });
    }
    // Never persist the credential into events.json.
    delete incomingData.adminToken;
    delete incomingData.adminPassword;

    // Get file metadata — this gives us the SHA (always fresh from GitHub API)
    const metaRes = await githubRequest('GET', `/repos/${repo}/contents/${filePath}`, token);
    let fileSha = '';
    let blobSha = '';
    if (metaRes.statusCode === 200 && metaRes.data.sha) {
      fileSha = metaRes.data.sha;
      blobSha = metaRes.data.sha;
    }

    // Fetch current file content via Blobs API (no caching, always up-to-date)
    let currentData = null;
    if (blobSha) {
      try {
        const rawContent = await fetchBlobContent(repo, blobSha, token);
        currentData = JSON.parse(rawContent);
      } catch (e) {
        console.log('Could not fetch blob, trying content field:', e.message);
        // Fallback: if blob was small enough, content might be in metaRes
        if (metaRes.data.content && metaRes.data.encoding === 'base64') {
          currentData = JSON.parse(Buffer.from(metaRes.data.content, 'base64').toString('utf-8'));
        }
      }
    }

    // If we could not read the live file we cannot safely merge, and a blind
    // overwrite is exactly the failure mode we are trying to eliminate. Refuse.
    if (blobSha && !currentData) {
      return response(503, {
        error: 'Could not read the current events.json to merge registrations. Save aborted to avoid data loss. Please retry.'
      });
    }

    // Build image map from current file (so we don't lose images stripped by admin)
    const currentImageMap = {};
    if (currentData && currentData.events) {
      currentData.events.forEach(evt => {
        if (evt.id && evt.image) {
          currentImageMap[evt.id] = evt.image;
        }
      });
    }

    console.log('Image map built with', Object.keys(currentImageMap).length, 'images');

    // Re-attach images to incoming events if they were stripped
    if (incomingData.events) {
      incomingData.events.forEach(evt => {
        if (!evt.image && evt.id && currentImageMap[evt.id]) {
          evt.image = currentImageMap[evt.id];
          console.log('Re-attached image for event:', evt.id);
        }
      });
    }

    // ---- PER-EVENT REGISTRATION MERGE (the important one) ----------------
    const mergeReport = mergeEventRegistrations(incomingData, currentData);
    if (mergeReport.rescuedRegistrations > 0) {
      console.log('Rescued', mergeReport.rescuedRegistrations,
        'registration(s) that the admin payload was missing:', mergeReport.rescuedEvents.join(', '));
    }
    if (mergeReport.preservedEvents.length > 0) {
      console.log('Preserved event(s) with paid registrations that the admin payload omitted:',
        mergeReport.preservedEvents.join(', '));
    }

    // Preserve legacy top-level registrations from current file if not included
    // or empty in incoming (unchanged behaviour, kept for older events).
    if (currentData && currentData.registrations) {
      if (!incomingData.registrations || Object.keys(incomingData.registrations).length === 0) {
        incomingData.registrations = currentData.registrations;
      } else {
        // Merge: keep any registration arrays from current that aren't in incoming
        Object.keys(currentData.registrations).forEach(key => {
          if (!incomingData.registrations[key]) {
            incomingData.registrations[key] = currentData.registrations[key];
          }
        });
      }
    }

    const content = JSON.stringify(incomingData, null, 2);
    const encoded = Buffer.from(content, 'utf-8').toString('base64');

    // Push update
    const putData = {
      message: 'Update events.json from admin panel',
      content: encoded,
    };
    if (fileSha) putData.sha = fileSha;

    const putRes = await githubRequest('PUT', `/repos/${repo}/contents/${filePath}`, token, putData);

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      return response(200, {
        success: true,
        message: 'Saved to GitHub',
        rescuedRegistrations: mergeReport.rescuedRegistrations,
        rescuedEvents: mergeReport.rescuedEvents,
        preservedEvents: mergeReport.preservedEvents
      });
    } else if (putRes.statusCode === 409) {
      // Someone (almost certainly the Square webhook) wrote between our read and
      // our write. Tell the admin to retry rather than forcing the overwrite.
      return response(409, { error: 'The file changed while saving (a registration probably landed). Please click Save again.' });
    } else {
      return response(putRes.statusCode, { error: putRes.data.message || 'GitHub save failed' });
    }
  } catch (err) {
    console.error('Save error:', err);
    return response(500, { error: err.message || 'Internal server error' });
  }
};
