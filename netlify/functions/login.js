// ============================================================================
// login.js — email + password sign in
//
// POST { email, password }   → returns { ok, token, member }
//
// For accounts WITHOUT a passwordHash (legacy code-flow users), returns a
// helpful error pointing them to verify-code (the old email-code flow) until
// they sign up to set a password.
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

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  try {
    const computed = crypto.scryptSync(password, salt, 64).toString('hex');
    if (computed.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
  } catch (_) { return false; }
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
        'User-Agent': 'Quarry-Login',
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
  const password = String(body.password || '');
  if (!email || !password) return reply(400, { ok: false, error: 'Email and password are required.' });

  let mFile;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    mFile = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  } catch (e) { return reply(500, { ok: false, error: 'Could not load members.' }); }

  const member = (mFile.members || []).find((x) => (x.email || '').toLowerCase() === email);
  if (!member) {
    return reply(401, { ok: false, error: 'No account found for that email. Try signing up.' });
  }
  if (!member.passwordHash) {
    return reply(403, {
      ok: false,
      needsSignup: true,
      error: "Looks like you have a Quarry account but haven't set a password yet. Hit Sign Up to claim your account and set one.",
    });
  }
  if (!verifyPassword(password, member.passwordHash)) {
    return reply(401, { ok: false, error: 'Wrong password. Try again or use Forgot Password.' });
  }

  return reply(200, {
    ok: true,
    token: makeSessionToken(email),
    member,
  });
};
