// ============================================================================
// credit-review.js — credit +100 points for posting a public review
//
// POST { token, platform }
//   platform: "google" | "yelp" | "tripadvisor" | "facebook"
//
// Member self-attests that they posted a review (any rating — IMPORTANT).
// Per Google / Yelp policies it is forbidden to incentivize positive reviews
// specifically; rewarding for ANY review (regardless of star rating) keeps us
// compliant. We do not check the rating, and the UI must never imply we do.
//
// Anti-abuse: 90-day cooldown per platform per member. Auditable via the
// member's history entry which records action=earn, source=review-{platform}.
//
// ENV: MEMBER_AUTH_SECRET, GITHUB_TOKEN
// ============================================================================
const crypto = require('crypto');
const https  = require('https');

const SECRET            = process.env.MEMBER_AUTH_SECRET || '';
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO       = 'quarrymanagement/quarry-website';
const SESSION_TTL_DAYS  = 30;
const REVIEW_POINTS     = 100;
const COOLDOWN_DAYS     = 90;
const ALLOWED_PLATFORMS = ['google', 'yelp', 'tripadvisor', 'facebook'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

// ─── Auth (mirrors verify-code.js) ──────────────────────────────────────────
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

// ─── GitHub helpers (members.json read/write) ──────────────────────────────
function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Review-Credit',
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

// ─── Handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!SECRET || !GITHUB_TOKEN) return reply(500, { ok: false, error: 'Server not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const session = verifySessionToken(body.token || '');
  if (!session) return reply(401, { ok: false, error: 'Not signed in or session expired' });

  const platform = String(body.platform || '').toLowerCase().trim();
  if (!ALLOWED_PLATFORMS.includes(platform)) {
    return reply(400, { ok: false, error: 'Unknown platform. Use one of: ' + ALLOWED_PLATFORMS.join(', ') });
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
  if (!member) return reply(404, { ok: false, error: 'Member record not found' });

  // Cooldown check: look for any prior review credit on this platform within COOLDOWN_DAYS
  const source = 'review-' + platform;
  const cutoffMs = Date.now() - COOLDOWN_DAYS * 24 * 3600 * 1000;
  const recent = (member.history || []).find((h) =>
    h.action === 'earn' && h.source === source && new Date(h.at).getTime() > cutoffMs
  );
  if (recent) {
    const nextEligibleMs = new Date(recent.at).getTime() + COOLDOWN_DAYS * 24 * 3600 * 1000;
    const daysLeft = Math.ceil((nextEligibleMs - Date.now()) / (24 * 3600 * 1000));
    return reply(409, {
      ok: false,
      error: 'Already credited for a ' + platform + ' review recently',
      cooldown: true,
      daysUntilEligible: daysLeft,
    });
  }

  // Credit the points
  member.currentPoints  = (member.currentPoints || 0) + REVIEW_POINTS;
  member.lifetimePoints = (member.lifetimePoints || 0) + REVIEW_POINTS;
  member.history = member.history || [];
  member.history.push({
    at: new Date().toISOString(),
    action: 'earn',
    source,
    delta: REVIEW_POINTS,
    by: 'self-attest',
    note: 'Member attested to posting a review on ' + platform,
  });
  mFile.json.lastUpdated = new Date().toISOString().split('T')[0];

  // Save back to GitHub
  try {
    const content = Buffer.from(JSON.stringify(mFile.json, null, 2), 'utf8').toString('base64');
    const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
      message: '+' + REVIEW_POINTS + ' pts (' + platform + ' review) — ' + member.email,
      content, sha: mFile.sha,
    });
    if (r.status !== 200 && r.status !== 201) throw new Error('HTTP ' + r.status);
  } catch (e) {
    return reply(500, { ok: false, error: 'Save failed: ' + e.message });
  }

  return reply(200, {
    ok: true,
    delta: REVIEW_POINTS,
    newBalance: member.currentPoints,
    lifetimePoints: member.lifetimePoints,
    platform,
    nextEligibleDays: COOLDOWN_DAYS,
  });
};
