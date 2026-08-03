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
const { readBlob, writeBlob } = require('./_blobs');
const { wrap } = require('./_sentry');

const SECRET = process.env.MEMBER_AUTH_SECRET || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';

// Brute-force limits for the 6-digit reset code. The code space is only 10^6
// and each code stays valid for 10 minutes, so an uncapped endpoint here is an
// account-takeover machine.
const RL_SCOPE = 'reset';
const RL_EMAIL_LIMIT = 5;   // failed codes per email per 15 min
const RL_IP_LIMIT = 20;     // failed codes per source IP per 15 min
const RL_TOO_MANY_MESSAGE = 'Too many incorrect codes. Please request a fresh code and try again in a few minutes.';

// ---- RL-BEGIN: failed-attempt limiter (sliding window, Netlify Blobs) -------
// Same storage + hashing style as request-code.js: counters live in Netlify
// Blobs and identifiers are hashed with rlSha256short() so raw emails and IPs
// never appear in a blob key. The difference is what is counted (failed auth
// attempts, not requests) and the failure mode.
//
// THIS LIMITER FAILS CLOSED. If the counter store is unavailable we reject the
// request (503) instead of letting it through. request-code.js deliberately
// fails OPEN because the worst case there is a few extra emails; here the
// counter is the only thing standing between an attacker and an account
// takeover, so an uncounted attempt is a free guess.
const RL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RL_STORE_DOWN_MESSAGE = 'We could not verify that right now. Please try again shortly.';

function rlSha256short(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}
// Read the source IP exactly the way request-code.js does.
function rlClientIp(event) {
  const h = (event && event.headers) || {};
  return String(h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || '').split(',')[0].trim();
}
function rlEmailKey(scope, email) {
  return 'rate-limit/' + scope + '-fail-email-' + rlSha256short(String(email || '').toLowerCase());
}
function rlIpKey(scope, ip) {
  return 'rate-limit/' + scope + '-fail-ip-' + rlSha256short(ip || 'unknown');
}
// readBlob() swallows transport errors and returns null, so a null read means
// "no attempts recorded". The dependable store-health signal is the write path
// (writeBlob returns false on failure), which runs on every counted failure —
// so a broken store surfaces on the first bad guess and becomes a 503 rather
// than an unmetered retry.
async function rlLoad(key, now, windowMs) {
  const rec = await readBlob(key); // may throw -> caller fails closed
  const list = (rec && Array.isArray(rec.ts)) ? rec.ts : [];
  return list.filter((t) => typeof t === 'number' && (now - t) < windowMs);
}
async function rlSave(key, ts) {
  const ok = await writeBlob(key, { ts: ts });
  if (ok === false) throw new Error('rate-limit store write failed: ' + key);
  return true;
}
// Is this email/IP already over budget? Throws if the store is unreachable.
async function rlCheckFailures(o) {
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const windowMs = o.windowMs || RL_WINDOW_MS;
  const emailTs = await rlLoad(rlEmailKey(o.scope, o.email), now, windowMs);
  if (emailTs.length >= o.emailLimit) return { allowed: false, reason: o.reason, scopeHit: 'email' };
  const ipTs = await rlLoad(rlIpKey(o.scope, o.ip), now, windowMs);
  if (ipTs.length >= o.ipLimit) return { allowed: false, reason: o.reason, scopeHit: 'ip' };
  return { allowed: true };
}
// Record ONE failed attempt against both counters. Throws if the store is
// unreachable — callers must turn that into a 503, never into a pass.
async function rlRecordFailure(o) {
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const windowMs = o.windowMs || RL_WINDOW_MS;
  const ek = rlEmailKey(o.scope, o.email);
  const ik = rlIpKey(o.scope, o.ip);
  const emailTs = await rlLoad(ek, now, windowMs);
  const ipTs = await rlLoad(ik, now, windowMs);
  emailTs.push(now);
  ipTs.push(now);
  await rlSave(ek, emailTs);
  await rlSave(ik, ipTs);
  return true;
}
// Clear the email counter after a success. Never throws: a store hiccup must
// not turn a valid sign-in into an error (stale counters expire on their own).
async function rlClearFailures(o) {
  try {
    await writeBlob(rlEmailKey(o.scope, o.email), { ts: [] });
  } catch (e) {
    console.warn('rate-limit clear failed:', e && e.message);
  }
  return true;
}
// ---- RL-END ----------------------------------------------------------------

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

exports.handler = wrap('reset-password', async (event) => {
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

  // Brute-force guard — must run before the code check, and fails closed.
  const clientIp = rlClientIp(event);
  const rlArgs = {
    scope: RL_SCOPE, email: email, ip: clientIp,
    emailLimit: RL_EMAIL_LIMIT, ipLimit: RL_IP_LIMIT,
    reason: RL_TOO_MANY_MESSAGE,
  };
  let rlGate;
  try {
    rlGate = await rlCheckFailures(rlArgs);
  } catch (e) {
    console.error('reset-password: rate-limit store unavailable:', e && e.message);
    return reply(503, { ok: false, error: RL_STORE_DOWN_MESSAGE });
  }
  if (!rlGate.allowed) {
    return reply(429, { ok: false, error: rlGate.reason, rateLimit: true });
  }

  if (!verifyCode(email, code)) {
    try {
      await rlRecordFailure(rlArgs);
    } catch (e) {
      console.error('reset-password: could not record failed attempt:', e && e.message);
      return reply(503, { ok: false, error: RL_STORE_DOWN_MESSAGE });
    }
    return reply(401, { ok: false, error: 'That code is invalid or expired. Request a fresh one.' });
  }
  // Correct code — wipe this email's failed-attempt counter.
  await rlClearFailures(rlArgs);

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
});
