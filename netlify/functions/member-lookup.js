// ============================================================================
// member-lookup.js — staff/admin search for members at the bar
//
// POST { adminPassword, query }
//   query: email, phone (any digits work), or name fragment
//
// Returns up to 10 matching members with: name, email, phone, tier,
// currentPoints, lifetimePoints, last 5 history entries, pendingRedemption
// (if any), bottle discount % (computed from tier).
//
// ENV: GITHUB_TOKEN, ADMIN_PASSWORD_HASH (or quarry2026 fallback)
// ============================================================================
const crypto = require('crypto');
const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

const TIER_DISCOUNT = { standard: 0, silver: 0, gold: 5, elite: 10, platinum: 10 };
const TIER_LABEL = { standard: 'Standard', silver: 'Silver', gold: 'Gold', elite: 'Elite', platinum: 'Elite' };

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
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-MemberLookup',
        'Accept': 'application/vnd.github.v3+json',
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

function publicMember(m) {
  if (!m) return null;
  const tier = m.tier || 'standard';
  return {
    id: m.id,
    name: m.name || '',
    email: m.email || '',
    phone: m.phone || '',
    tier: tier,
    tierLabel: TIER_LABEL[tier] || 'Standard',
    bottleDiscountPct: TIER_DISCOUNT[tier] || 0,
    currentPoints: m.currentPoints || 0,
    lifetimePoints: m.lifetimePoints || 0,
    totalRedemptions: m.totalRedemptions || 0,
    joinedAt: m.joinedAt || null,
    lastVisitAt: m.lastVisitAt || null,
    marketingOptIn: !!m.marketingOptIn,
    smsOptIn: !!m.smsOptIn,
    birthday: m.birthday || '',
    pendingRedemption: m.pendingRedemption || null,
    recentHistory: (m.history || []).slice(-5).reverse(),
  };
}

function score(m, q) {
  const qLower = q.toLowerCase().trim();
  const qDigits = q.replace(/\D/g, '');
  let s = 0;
  const email = (m.email || '').toLowerCase();
  const name = (m.name || '').toLowerCase();
  const phone = (m.phone || '').replace(/\D/g, '');
  if (email === qLower) s += 100;
  else if (qLower && email.includes(qLower)) s += 50;
  if (name === qLower) s += 80;
  else if (qLower && name.includes(qLower)) s += 30;
  if (qDigits.length >= 4) {
    if (phone === qDigits) s += 100;
    else if (phone.endsWith(qDigits)) s += 60;
    else if (phone.includes(qDigits)) s += 20;
  }
  return s;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!GITHUB_TOKEN) return reply(500, { ok: false, error: 'Server not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });
  const query = String(body.query || '').trim();
  if (!query || query.length < 2) return reply(400, { ok: false, error: 'Enter at least 2 characters' });

  let mFile;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    mFile = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  } catch (e) { return reply(500, { ok: false, error: 'Could not load members' }); }

  const all = mFile.members || [];
  const matched = all
    .map((m) => ({ m, s: score(m, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 10)
    .map((x) => publicMember(x.m));

  return reply(200, { ok: true, count: matched.length, members: matched });
};
