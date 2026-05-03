// ============================================================================
// verify-code.js — verify 6-digit code, return session token + member record
//
// Two modes:
//   POST { email, code } → if valid, returns { token, member, isNewMember }.
//                          Auto-creates member record on first sign-in (claim,
//                          don't duplicate — if email already exists, just
//                          re-attaches to the existing record with all its points).
//   POST { token }       → validates session token, returns refreshed member data
//                          (used on app load to restore session)
//
// ENV: MEMBER_AUTH_SECRET, GITHUB_TOKEN
// ============================================================================
const crypto = require('crypto');
const https = require('https');

const SECRET = process.env.MEMBER_AUTH_SECRET || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const SESSION_TTL_DAYS = 30;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

// ─── Code/token crypto ─────────────────────────────────────────────────────
function codeForMinute(email, min) {
  const h = crypto.createHmac('sha256', SECRET)
    .update(email.toLowerCase().trim() + ':' + min)
    .digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
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
    const expectedSig = crypto.createHmac('sha256', SECRET).update(email + ':' + issuedStr).digest('hex');
    if (sig !== expectedSig) return null;
    const ageMs = Date.now() - parseInt(issuedStr, 10);
    if (ageMs > SESSION_TTL_DAYS * 24 * 3600 * 1000) return null;
    return { email, issued: parseInt(issuedStr, 10) };
  } catch (_) { return null; }
}

// ─── GitHub helpers ────────────────────────────────────────────────────────
function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: path,
      method: method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Auth',
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

async function findOrCreateMember(email) {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
  if (r.status !== 200) throw new Error('Could not load members.json: HTTP ' + r.status);
  const json = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  const sha = r.data.sha;

  const existing = (json.members || []).find((m) => (m.email || '').toLowerCase() === email);
  if (existing) return { member: existing, isNew: false };

  // Auto-create with claim semantics: if Toast has already credited points
  // to this email (member doesn't exist yet but webhook may have logged),
  // they'll start fresh here. The webhook returns "unmatched" when there's
  // no member, so points are NOT lost — they're just not credited until the
  // member exists. After this signup, future Toast orders will credit normally.
  const newMember = {
    id: 'm_' + Date.now().toString(36) + '_' + crypto.randomBytes(2).toString('hex'),
    name: '',
    email: email,
    phone: '',
    birthday: '',
    joinedAt: new Date().toISOString(),
    lastVisitAt: null,
    tier: 'standard',
    currentPoints: 0,
    lifetimePoints: 0,
    totalRedemptions: 0,
    marketingOptIn: true,
    smsOptIn: false,
    notes: '',
    history: [{
      at: new Date().toISOString(),
      action: 'created',
      delta: 0,
      by: 'app-signup',
      note: 'Self-signup via app',
    }],
  };

  if (!Array.isArray(json.members)) json.members = [];
  json.members.push(newMember);
  json.lastUpdated = new Date().toISOString().split('T')[0];

  const content = Buffer.from(JSON.stringify(json, null, 2)).toString('base64');
  const put = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
    message: 'members: self-signup ' + email,
    content: content,
    sha: sha,
  });
  if (put.status !== 200 && put.status !== 201) {
    throw new Error('Could not save member: HTTP ' + put.status);
  }
  return { member: newMember, isNew: true };
}

async function lookupMember(email) {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
  if (r.status !== 200) return null;
  const json = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  return (json.members || []).find((m) => (m.email || '').toLowerCase() === email) || null;
}

// ─── Handler ───────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return reply(405, { ok: false, error: 'POST only' });
  if (!SECRET)        return reply(500, { ok: false, error: 'MEMBER_AUTH_SECRET not configured' });
  if (!GITHUB_TOKEN)  return reply(500, { ok: false, error: 'GITHUB_TOKEN not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  // Mode 2: token refresh
  if (body.token) {
    const session = verifySessionToken(body.token);
    if (!session) return reply(401, { ok: false, error: 'Invalid or expired session' });
    const member = await lookupMember(session.email);
    return reply(200, { ok: true, email: session.email, member: member });
  }

  // Mode 1: email + code
  const email = (body.email || '').trim().toLowerCase();
  const code = (body.code || '').replace(/\D/g, '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { ok: false, error: 'Valid email required' });
  if (code.length !== 6) return reply(400, { ok: false, error: 'Enter the 6-digit code' });

  // Check code matches any of the last 10 minutes
  const now = Math.floor(Date.now() / 60000);
  let matchedMinute = -1;
  for (let i = 0; i < 10; i++) {
    if (codeForMinute(email, now - i) === code) { matchedMinute = now - i; break; }
  }
  if (matchedMinute < 0) return reply(401, { ok: false, error: 'Invalid or expired code' });

  let result;
  try { result = await findOrCreateMember(email); }
  catch (e) { return reply(500, { ok: false, error: 'Member lookup failed: ' + e.message }); }

  return reply(200, {
    ok: true,
    token: makeSessionToken(email),
    email: email,
    member: result.member,
    isNewMember: result.isNew,
  });
};
