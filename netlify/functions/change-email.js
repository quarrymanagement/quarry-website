// ============================================================================
// change-email.js — let a signed-in member change their email address.
//
// Two-step flow:
//
//   STEP 1: POST { token, newEmail }
//      Sends a 6-digit confirmation code to the NEW email address. Uses the
//      same time-derived HMAC scheme as request-code.js (no storage needed).
//      Returns ok=true if the new email is well-formed, not already used by
//      another member, and the email dispatched successfully.
//
//   STEP 2: POST { token, newEmail, code }
//      Verifies the code, swaps member.email, invalidates the old session by
//      issuing a fresh session token bound to the new email, returns the new
//      token + member record. The OLD session token is implicitly dead (the
//      email no longer matches its signed payload).
//
// Also writes a history entry recording the change.
//
// ENV: MEMBER_AUTH_SECRET, GITHUB_TOKEN, SENDGRID_API_KEY
// ============================================================================
const crypto = require('crypto');
const https  = require('https');
const { wrap } = require('./_sentry');

const SECRET           = process.env.MEMBER_AUTH_SECRET || '';
const GITHUB_TOKEN     = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO      = 'quarrymanagement/quarry-website';
const SENDGRID_KEY     = process.env.SENDGRID_API_KEY || '';
const SESSION_TTL_DAYS = 30;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

// Mirror the code derivation in request-code.js / reset-password.js.
// The email used in the HMAC must be a stable per-request identifier — here we
// scope codes to the NEW email so a stolen code can't be replayed against a
// different change-email request.
function codeForMinute(email, min) {
  const h = crypto.createHmac('sha256', SECRET)
    .update(email.toLowerCase().trim() + ':change-email:' + min)
    .digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}

function verifyCode(email, code) {
  if (!/^\d{6}$/.test(code)) return false;
  const nowMin = Math.floor(Date.now() / 60000);
  // Accept current minute + 9 previous (10-min window) — matches reset-password
  for (let i = 0; i <= 9; i++) {
    if (codeForMinute(email, nowMin - i) === code) return true;
  }
  return false;
}

function makeSessionToken(email) {
  const issued = Date.now();
  const payload = email.toLowerCase() + ':' + issued;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(payload + ':' + sig).toString('base64url');
}

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
        'User-Agent': 'Quarry-Change-Email',
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

async function sendVerificationCode(toEmail, code, currentEmail) {
  if (!SENDGRID_KEY) return { skipped: true };
  const body = JSON.stringify({
    personalizations: [{ to: [{ email: toEmail }] }],
    from: { email: 'management@thequarrystl.com', name: 'The Quarry' },
    subject: 'Confirm your new Quarry email address',
    categories: ['quarry-change-email'],
    content: [{
      type: 'text/html',
      value:
        '<div style="font-family:Georgia,serif;max-width:480px;margin:40px auto;padding:32px;background:#1A1A1A;color:#F5F0E8;text-align:center;border-radius:8px;">' +
          '<div style="font-size:0.7rem;letter-spacing:0.32em;color:#B8933A;margin-bottom:18px;">THE QUARRY · NEW MELLE · MO</div>' +
          '<h1 style="font-size:1.4rem;font-weight:600;margin-bottom:12px;color:#F5F0E8;">Confirm your new email</h1>' +
          '<p style="font-size:0.9rem;color:rgba(245,240,232,0.7);line-height:1.6;margin-bottom:20px;">Someone — hopefully you — asked to change the Quarry Rewards account currently at <strong>' + currentEmail + '</strong> over to this address. Enter this code in the app to confirm:</p>' +
          '<div style="font-size:2.6rem;letter-spacing:0.16em;font-weight:600;color:#D4AF6A;margin:24px 0;padding:18px;background:rgba(184,147,58,0.1);border:1px solid rgba(196,149,106,0.25);">' + code + '</div>' +
          '<div style="font-size:0.8rem;color:rgba(245,240,232,0.55);line-height:1.6;">Expires in 10 minutes. If you did not request this, you can safely ignore this email — nothing has changed on the account.</div>' +
        '</div>',
    }],
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SENDGRID_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 200) }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.write(body);
    req.end();
  });
}

exports.handler = wrap('change-email', async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!SECRET || !GITHUB_TOKEN) return reply(500, { ok: false, error: 'Server not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const session = verifySessionToken(body.token || '');
  if (!session) return reply(401, { ok: false, error: 'Not signed in or session expired' });

  const oldEmail = session.email.toLowerCase();
  const newEmail = String(body.newEmail || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) {
    return reply(400, { ok: false, error: 'Enter a valid new email address.' });
  }
  if (newEmail === oldEmail) {
    return reply(400, { ok: false, error: 'New email is the same as your current one.' });
  }

  // Load members.json once (used in both steps)
  let mFile;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    mFile = { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
  } catch (e) {
    return reply(500, { ok: false, error: 'Could not load members.json: ' + e.message });
  }
  const members = mFile.json.members || [];

  // Block if the new email already belongs to another account
  const collision = members.find((m) => (m.email || '').toLowerCase() === newEmail);
  if (collision) {
    return reply(409, { ok: false, error: 'That email is already in use by another Quarry account.' });
  }

  const me = members.find((m) => (m.email || '').toLowerCase() === oldEmail);
  if (!me) return reply(404, { ok: false, error: 'Member record not found for the current session.' });

  // STEP 1: no code provided → send a verification code to the NEW email
  if (!body.code) {
    const minute = Math.floor(Date.now() / 60000);
    const code = codeForMinute(newEmail, minute);
    const r = await sendVerificationCode(newEmail, code, oldEmail);
    if (r.skipped) return reply(500, { ok: false, error: 'Email sending not configured' });
    if (r.status >= 400) return reply(500, { ok: false, error: 'Could not send verification code (' + r.status + ')' });
    return reply(200, { ok: true, step: 1, message: 'Code sent to ' + newEmail + '. Enter it to confirm.', expiresInMinutes: 10 });
  }

  // STEP 2: code provided → verify + swap
  const code = String(body.code || '').replace(/\D/g, '');
  if (!verifyCode(newEmail, code)) {
    return reply(401, { ok: false, error: 'That code is invalid or expired. Request a fresh one.' });
  }

  const now = new Date().toISOString();
  me.email = newEmail;
  me.history = me.history || [];
  me.history.push({
    at: now,
    action: 'email-change',
    from: oldEmail,
    to: newEmail,
    by: 'self',
    note: 'Self-service email change verified via 6-digit code',
  });
  mFile.json.lastUpdated = now.split('T')[0];

  try {
    const content = Buffer.from(JSON.stringify(mFile.json, null, 2), 'utf8').toString('base64');
    const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
      message: 'change-email: ' + oldEmail + ' → ' + newEmail,
      content, sha: mFile.sha,
    });
    if (r.status !== 200 && r.status !== 201) throw new Error('HTTP ' + r.status);
  } catch (e) {
    return reply(500, { ok: false, error: 'Save failed: ' + e.message });
  }

  return reply(200, {
    ok: true,
    step: 2,
    oldEmail,
    newEmail,
    token: makeSessionToken(newEmail),
    member: me,
  });
});
