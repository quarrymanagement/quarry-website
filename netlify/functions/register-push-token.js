// ============================================================================
// register-push-token.js — store a member's APNs (iOS) or FCM (Android) device
// token so we can later send them push notifications.
//
// POST { token, platform, deviceToken, deviceModel?, appVersion? }
//   token        — the member session token (from verify-code.js)
//   platform     — "ios" | "android"
//   deviceToken  — the APNs/FCM token from @capacitor/push-notifications
//
// Stored on the member record at member.devices[] so we never spam a customer
// with the same notification on multiple devices, and so unregister is easy
// when they sign out. Idempotent — re-registering refreshes the timestamp.
//
// ENV: MEMBER_AUTH_SECRET, GITHUB_TOKEN
// ============================================================================
const crypto = require('crypto');
const https  = require('https');
const { wrap } = require('./_sentry');

const SECRET           = process.env.MEMBER_AUTH_SECRET || '';
const GITHUB_TOKEN     = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO      = 'quarrymanagement/quarry-website';
const SESSION_TTL_DAYS = 30;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function verifySessionToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const [email, issuedStr, sig] = parts;
    const expected = crypto.createHmac('sha256', SECRET).update(email + ':' + issuedStr).digest('hex');
    if (sig !== expected) return null;
    const ageMs = Date.now() - parseInt(issuedStr, 10);
    if (ageMs > SESSION_TTL_DAYS * 24 * 3600 * 1000) return null;
    return { email };
  } catch (_) { return null; }
}

function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Push-Register',
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

exports.handler = wrap('register-push-token', async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!SECRET || !GITHUB_TOKEN) return reply(500, { ok: false, error: 'Server not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const session = verifySessionToken(body.token || '');
  if (!session) return reply(401, { ok: false, error: 'Not signed in' });

  const platform = String(body.platform || '').toLowerCase();
  if (platform !== 'ios' && platform !== 'android') {
    return reply(400, { ok: false, error: 'platform must be ios or android' });
  }
  const deviceToken = String(body.deviceToken || '').trim();
  if (!deviceToken || deviceToken.length < 16) {
    return reply(400, { ok: false, error: 'deviceToken missing or too short' });
  }

  // Load members.json
  let mFile;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    mFile = { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
  } catch (e) {
    return reply(500, { ok: false, error: 'Could not load members.json: ' + e.message });
  }

  const member = (mFile.json.members || []).find((x) => (x.email || '').toLowerCase() === session.email.toLowerCase());
  if (!member) return reply(404, { ok: false, error: 'Member not found' });

  member.devices = member.devices || [];
  // Dedupe by deviceToken — refresh if we've seen it before
  const existing = member.devices.find((d) => d.deviceToken === deviceToken);
  const now = new Date().toISOString();
  if (existing) {
    existing.lastSeen = now;
    existing.platform = platform;
    if (body.appVersion) existing.appVersion = String(body.appVersion);
    if (body.deviceModel) existing.deviceModel = String(body.deviceModel);
  } else {
    member.devices.push({
      platform,
      deviceToken,
      deviceModel: body.deviceModel ? String(body.deviceModel) : '',
      appVersion: body.appVersion ? String(body.appVersion) : '',
      registeredAt: now,
      lastSeen: now,
    });
  }
  mFile.json.lastUpdated = now.split('T')[0];

  try {
    const content = Buffer.from(JSON.stringify(mFile.json, null, 2), 'utf8').toString('base64');
    const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
      message: 'register push device (' + platform + ') for ' + member.email,
      content, sha: mFile.sha,
    });
    if (r.status !== 200 && r.status !== 201) throw new Error('HTTP ' + r.status);
  } catch (e) {
    return reply(500, { ok: false, error: 'Save failed: ' + e.message });
  }

  return reply(200, { ok: true, devices: member.devices.length });
});
