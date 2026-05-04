// ============================================================================
// reset-password.js — verify the 6-digit code from request-code, set a new password
//
// POST { email, code, newPassword }
//
// The 6-digit code is the same time-derived HMAC code that request-code.js
// sends out. Validates against the last 10 minutes of windows. On success,
// updates passwordHash on the member record and returns a fresh session token.
//
// Forgot-password UX:
//   1. App calls /request-code with { email } → SendGrid email goes out
//   2. User enters code + new password in app
//   3. App calls /reset-password with { email, code, newPassword }
//
// ENV: MEMBER_AUTH_SECRET, GITHUB_TOKEN
// ============================================================================
const crypto = require('crypto');
const https = require('https');

const SECRET = process.env.MEMBER_AUTH_SECRET || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function codeForMinute(email, min) {
  const h = crypto.createHmac('sha256', SECRET)
    .update(email.toLowerCase().trim() + ':' + min)
    .digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}

function verifyCode(email, code) {
  if (!/^\d{6}$/.test(code)) return false;
  const nowMin = Math.floor(Date.now() / 60000);
  // Accept current minute and the 9 previous (10-min window total)
  for (let i = 0; i <= 9; i++) {
    if (codeForMinute(email, nowMin - i) === code) return true;
  }
  return false;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function makeSessionToken(email) {
  const issued = Date.now();
  const payload = email.toLowerCase() + ':' + issued;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(payload + ':' + sig).toString('base64url');
}

function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Reset',
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!SECRET || !GITHUB_TOKEN) return reply(500, { ok: false, error: 'Server not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').replace(/\D/g, '');
  const newPassword = String(body.newPassword || '');
  if (!email || !code) return reply(400, { ok: false, error: 'Email and code required.' });
  if (!newPassword || newPassword.length < 8) return reply(400, { ok: false, error: 'New password must be at least 8 characters.' });

  if (!verifyCode(email, code)) {
    return reply(401, { ok: false, error: 'That code is invalid or expired. Request a fresh one.' });
  }

  // Load + update member
  let mFile;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    mFile = { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
  } catch (e) { return reply(500, { ok: false, error: 'Could not load members.' }); }

  const member = (mFile.json.members || []).find((x) => (x.email || '').toLowerCase() === email);
  if (!member) return reply(404, { ok: false, error: 'No account found for that email.' });

  member.passwordHash = hashPassword(newPassword);
  member.history = member.history || [];
  member.history.push({
    at: new Date().toISOString(),
    action: 'password-reset',
    by: 'self',
    note: 'Password reset via 6-digit email code',
  });
  mFile.json.lastUpdated = new Date().toISOString().split('T')[0];

  try {
    const content = Buffer.from(JSON.stringify(mFile.json, null, 2), 'utf8').toString('base64');
    const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
      message: 'reset-password: ' + email, content, sha: mFile.sha,
    });
    if (r.status !== 200 && r.status !== 201) throw new Error('HTTP ' + r.status);
  } catch (e) { return reply(500, { ok: false, error: 'Could not save password: ' + e.message }); }

  return reply(200, {
    ok: true,
    token: makeSessionToken(email),
    member,
  });
};
