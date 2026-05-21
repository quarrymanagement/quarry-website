// ============================================================================
// send-push.js — admin-only push notification fan-out
//
// POST {
//   adminPassword,
//   title,
//   body,
//   audience: "all" | "tier-gold" | "tier-elite" | "low-points" | "specific",
//   memberEmails?: ["x@y.com", ...]   // when audience === "specific"
//   data?: { tab?: "rewards"|"events"|"menu"|"home" }
// }
//
// Sends APNs (iOS) + FCM (Android) pushes to all matching devices.
// The native client registers device tokens via register-push-token.js, so
// this function just iterates member.devices[] and dispatches.
//
// REQUIRED ENV VARS (need to be added to Netlify before this works):
//   ADMIN_PASSWORD_HASH        — existing admin auth
//   FCM_SERVER_KEY             — from Firebase Console → Project Settings →
//                                Cloud Messaging → Server key (legacy) or use
//                                FCM v1 with a service-account JSON.
//   APNS_KEY_ID                — Apple Developer → Keys → APNs key ID
//   APNS_TEAM_ID               — your Apple Developer Team ID
//   APNS_AUTH_KEY              — contents of the .p8 file (entire file as a
//                                multi-line env var, including BEGIN/END lines)
//   APNS_BUNDLE_ID             — "com.thequarrystl.rewards"
//
// Until those are set the function returns a friendly 503 so you can deploy
// the code now and wire APNs/FCM later.
// ============================================================================
const crypto = require('crypto');
const https  = require('https');
const { wrap } = require('./_sentry');

const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const GITHUB_TOKEN        = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO         = 'quarrymanagement/quarry-website';

const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || '';
const APNS_KEY_ID    = process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID   = process.env.APNS_TEAM_ID || '';
const APNS_AUTH_KEY  = process.env.APNS_AUTH_KEY || '';
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.thequarrystl.rewards';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Push-Send',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}') }); }
        catch (_) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── FCM (Android) ──────────────────────────────────────────────────────────
function sendFcm(deviceToken, title, body, data) {
  return new Promise((resolve) => {
    if (!FCM_SERVER_KEY) return resolve({ ok: false, skipped: 'no FCM_SERVER_KEY' });
    const payload = JSON.stringify({
      to: deviceToken,
      notification: { title, body, sound: 'default', click_action: 'FCM_PLUGIN_ACTIVITY' },
      data: data || {},
      priority: 'high',
    });
    const req = https.request({
      hostname: 'fcm.googleapis.com',
      path: '/fcm/send',
      method: 'POST',
      headers: {
        'Authorization': 'key=' + FCM_SERVER_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: d.slice(0, 200) }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

// ─── APNs (iOS) via JWT auth ───────────────────────────────────────────────
function apnsJwt() {
  if (!APNS_AUTH_KEY || !APNS_KEY_ID || !APNS_TEAM_ID) return null;
  const header = { alg: 'ES256', kid: APNS_KEY_ID };
  const payload = { iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) };
  const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = b64u(header) + '.' + b64u(payload);
  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  sign.end();
  const sig = sign.sign({ key: APNS_AUTH_KEY, dsaEncoding: 'ieee-p1363' });
  return signingInput + '.' + Buffer.from(sig).toString('base64url');
}

function sendApns(deviceToken, title, body, data) {
  return new Promise((resolve) => {
    const jwt = apnsJwt();
    if (!jwt) return resolve({ ok: false, skipped: 'APNs creds missing' });
    const payload = JSON.stringify({
      aps: { alert: { title, body }, sound: 'default', badge: 1 },
      ...(data || {}),
    });
    const req = https.request({
      hostname: 'api.push.apple.com',
      path: '/3/device/' + deviceToken,
      method: 'POST',
      headers: {
        'authorization': 'bearer ' + jwt,
        'apns-topic': APNS_BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: d.slice(0, 200) }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

// ─── Audience filter ───────────────────────────────────────────────────────
function memberMatchesAudience(m, audience, memberEmails) {
  if (audience === 'all') return true;
  if (audience === 'tier-gold')  return (m.tier || '').toLowerCase() === 'gold' || (m.tier || '').toLowerCase() === 'elite';
  if (audience === 'tier-elite') return (m.tier || '').toLowerCase() === 'elite';
  if (audience === 'low-points') return (m.currentPoints || 0) < 500;
  if (audience === 'specific')   return (memberEmails || []).map(e => e.toLowerCase()).includes((m.email || '').toLowerCase());
  return false;
}

exports.handler = wrap('send-push', async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'auth' });
  if (!body.title || !body.body) return reply(400, { ok: false, error: 'title and body required' });

  // Friendly 503 until credentials are in place
  if (!FCM_SERVER_KEY && (!APNS_AUTH_KEY || !APNS_KEY_ID || !APNS_TEAM_ID)) {
    return reply(503, {
      ok: false,
      error: 'Push not yet configured',
      detail: 'Set FCM_SERVER_KEY (Android) and/or APNS_KEY_ID, APNS_TEAM_ID, APNS_AUTH_KEY, APNS_BUNDLE_ID (iOS) in Netlify env vars to enable.',
    });
  }

  // Load members
  let mFile;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    mFile = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  } catch (e) {
    return reply(500, { ok: false, error: 'Could not load members.json: ' + e.message });
  }

  const audience = body.audience || 'all';
  const memberEmails = Array.isArray(body.memberEmails) ? body.memberEmails : [];
  const targets = (mFile.members || []).filter((m) => memberMatchesAudience(m, audience, memberEmails));

  let attempted = 0, succeeded = 0;
  const errors = [];
  for (const m of targets) {
    for (const d of (m.devices || [])) {
      attempted++;
      const send = d.platform === 'ios' ? sendApns : sendFcm;
      const result = await send(d.deviceToken, body.title, body.body, body.data || {});
      if (result.ok) succeeded++;
      else errors.push({ email: m.email, platform: d.platform, ...result });
    }
  }

  return reply(200, {
    ok: true,
    audience,
    targetMembers: targets.length,
    attempted,
    succeeded,
    failures: errors.length,
    errorSample: errors.slice(0, 5),
  });
});
