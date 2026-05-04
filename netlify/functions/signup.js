// ============================================================================
// signup.js — full member signup with password + opt-ins
//
// POST { name, email, phone, dob, password, marketingOptIn, smsOptIn }
//
// Behavior:
//   - Validates required fields (name, email, phone, password)
//   - Rejects if email already has a passwordHash (existing account)
//   - If email exists WITHOUT a passwordHash (legacy code-flow user), claims
//     the existing record and adds the password
//   - Hashes password with scrypt
//   - Awards welcome bonus (250) + email opt-in bonus (10) + sms opt-in bonus (10)
//   - Adds member to SendGrid Subscribed list (if marketingOptIn)
//   - Sends welcome email
//   - Returns session token
//
// ENV: MEMBER_AUTH_SECRET, GITHUB_TOKEN, SENDGRID_API_KEY,
//      SENDGRID_LIST_SUBSCRIBED (existing list ID)
// ============================================================================
const crypto = require('crypto');
const https = require('https');

const SECRET = process.env.MEMBER_AUTH_SECRET || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';
const SENDGRID_LIST_SUBSCRIBED = process.env.SENDGRID_LIST_SUBSCRIBED || '';

const SESSION_TTL_DAYS = 30;
const WELCOME_BONUS = 250;
const EMAIL_OPTIN_BONUS = 10;
const SMS_OPTIN_BONUS = 10;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

// ─── Password hashing (scrypt, salt:hash format) ───────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

// ─── Session token ─────────────────────────────────────────────────────────
function makeSessionToken(email) {
  const issued = Date.now();
  const payload = email.toLowerCase() + ':' + issued;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(payload + ':' + sig).toString('base64url');
}

// ─── HTTPS helper ──────────────────────────────────────────────────────────
function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}'), raw: d }); }
        catch (_) { resolve({ status: res.statusCode, data: d, raw: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function gh(method, path, body) {
  return httpsRequest({
    hostname: 'api.github.com', path, method,
    headers: {
      'Authorization': 'token ' + GITHUB_TOKEN,
      'User-Agent': 'Quarry-Signup',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
  }, body);
}

async function loadJson(filePath) {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/' + filePath);
  if (r.status !== 200) throw new Error('GitHub load: HTTP ' + r.status);
  return { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
}

async function saveJson(filePath, json, sha, message) {
  const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64');
  const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/' + filePath, { message, content, sha });
  if (r.status !== 200 && r.status !== 201) throw new Error('GitHub save: HTTP ' + r.status);
  return r.data;
}

// ─── SendGrid: add contact to subscribed list ──────────────────────────────
async function sgAddContact({ email, name, phone, dob }) {
  if (!SENDGRID_KEY || !SENDGRID_LIST_SUBSCRIBED) return false;
  const [firstName, ...rest] = (name || '').split(/\s+/);
  const lastName = rest.join(' ');
  try {
    const r = await httpsRequest({
      hostname: 'api.sendgrid.com', path: '/v3/marketing/contacts', method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + SENDGRID_KEY,
        'Content-Type': 'application/json',
      },
    }, {
      list_ids: [SENDGRID_LIST_SUBSCRIBED],
      contacts: [{
        email,
        first_name: firstName || '',
        last_name: lastName || '',
        phone_number: phone || '',
      }],
    });
    return r.status >= 200 && r.status < 300;
  } catch (_) { return false; }
}

// ─── SendGrid: send welcome email ──────────────────────────────────────────
async function sendWelcomeEmail({ email, firstName, totalBonusPts }) {
  if (!SENDGRID_KEY) return;
  try {
    await httpsRequest({
      hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SENDGRID_KEY,
        'Content-Type': 'application/json',
      },
    }, {
      personalizations: [{ to: [{ email }] }],
      from: { email: 'management@thequarrystl.com', name: 'The Quarry STL' },
      subject: 'Welcome to The Quarry — Your ' + totalBonusPts + ' Welcome Points are Live',
      content: [{
        type: 'text/html',
        value:
          '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
          '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
          '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">REWARDS FAMILY</p></div>' +
          '<div style="padding:32px 24px;background:#FFFFFF">' +
          '<h2 style="color:#2C1A0E;margin-top:0">Welcome to the family, ' + (firstName || 'friend') + '.</h2>' +
          '<p style="color:#444;font-size:1rem;line-height:1.6">You\'re officially a Quarry member. Your welcome bonus of <strong style="color:#B8933A">' + totalBonusPts + ' points</strong> is already in your account.</p>' +
          '<p style="color:#444;font-size:1rem;line-height:1.6">Earn 10 points for every $1 you spend, plus +10 every time you stop in. Hit 500 points and grab a bucket of balls at Surfside Hole-In-One. Hit 1,000 and get $10 off your next bill.</p>' +
          '<p style="color:#444;font-size:1rem;line-height:1.6">See you soon.</p>' +
          '<p style="color:#444;font-style:italic;margin-top:24px">— The Quarry Team</p>' +
          '</div></div>',
      }],
    });
  } catch (_) { /* email fail shouldn't block signup */ }
}

// ─── Main handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!SECRET || !GITHUB_TOKEN) return reply(500, { ok: false, error: 'Server not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const dob = String(body.dob || '').trim();
  const password = String(body.password || '');
  const marketingOptIn = !!body.marketingOptIn;
  const smsOptIn = !!body.smsOptIn;

  if (!name) return reply(400, { ok: false, error: 'Name is required.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { ok: false, error: 'Enter a valid email.' });
  if (!phone || phone.replace(/\D/g, '').length < 10) return reply(400, { ok: false, error: 'Enter a valid phone number (10+ digits).' });
  if (!password || password.length < 8) return reply(400, { ok: false, error: 'Password must be at least 8 characters.' });
  // DOB optional; but if present, must look plausible YYYY-MM-DD
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return reply(400, { ok: false, error: 'Date of birth must be YYYY-MM-DD.' });

  // Load members
  let mFile;
  try { mFile = await loadJson('members.json'); }
  catch (e) { return reply(500, { ok: false, error: 'Could not load members file.' }); }

  const existing = (mFile.json.members || []).find((x) => (x.email || '').toLowerCase() === email);

  if (existing && existing.passwordHash) {
    return reply(409, { ok: false, error: 'An account with this email already exists. Try signing in instead, or use Forgot Password.' });
  }

  // Compute total bonus
  const totalBonus = WELCOME_BONUS + (marketingOptIn ? EMAIL_OPTIN_BONUS : 0) + (smsOptIn ? SMS_OPTIN_BONUS : 0);
  const now = new Date().toISOString();
  const passHash = hashPassword(password);

  let member;
  if (existing) {
    // Claim the existing record (legacy code-flow user)
    member = existing;
    member.passwordHash = passHash;
    member.name = member.name || name;
    member.phone = member.phone || phone;
    member.birthday = member.birthday || dob;
    member.marketingOptIn = marketingOptIn;
    member.smsOptIn = smsOptIn;
    member.currentPoints = (member.currentPoints || 0) + totalBonus;
    member.lifetimePoints = (member.lifetimePoints || 0) + totalBonus;
    member.history = member.history || [];
    member.history.push({
      at: now,
      action: 'earn',
      source: 'signup-claim',
      delta: totalBonus,
      note: 'Existing record claimed via password signup (welcome ' + WELCOME_BONUS + (marketingOptIn ? ' + email +' + EMAIL_OPTIN_BONUS : '') + (smsOptIn ? ' + sms +' + SMS_OPTIN_BONUS : '') + ')',
    });
  } else {
    // New member
    member = {
      id: 'm_' + Date.now().toString(36) + '_' + crypto.randomBytes(2).toString('hex'),
      name,
      email,
      phone,
      birthday: dob,
      passwordHash: passHash,
      joinedAt: now,
      lastVisitAt: null,
      tier: 'standard',
      currentPoints: totalBonus,
      lifetimePoints: totalBonus,
      totalRedemptions: 0,
      marketingOptIn,
      smsOptIn,
      notes: '',
      history: [{
        at: now,
        action: 'earn',
        source: 'signup',
        delta: totalBonus,
        note: 'Welcome bonus ' + WELCOME_BONUS + (marketingOptIn ? ' + email opt-in +' + EMAIL_OPTIN_BONUS : '') + (smsOptIn ? ' + sms opt-in +' + SMS_OPTIN_BONUS : ''),
      }],
    };
    mFile.json.members = mFile.json.members || [];
    mFile.json.members.push(member);
  }
  mFile.json.lastUpdated = new Date().toISOString().split('T')[0];

  try {
    await saveJson('members.json', mFile.json, mFile.sha, 'signup: ' + email);
  } catch (e) {
    return reply(500, { ok: false, error: 'Could not save member: ' + e.message });
  }

  // Add to SendGrid contacts (if opted in) — fire and forget
  if (marketingOptIn) {
    sgAddContact({ email, name, phone, dob }).catch(() => {});
  }

  // Send welcome email — fire and forget
  sendWelcomeEmail({ email, firstName: (name.split(/\s+/)[0] || ''), totalBonusPts: totalBonus }).catch(() => {});

  return reply(200, {
    ok: true,
    token: makeSessionToken(email),
    member,
    bonusAwarded: totalBonus,
  });
};
