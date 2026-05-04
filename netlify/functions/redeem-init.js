// ============================================================================
// redeem-init.js — member starts a redemption
//
// POST { token, rewardId } → returns a 6-character claim code valid for 5 min.
// The bartender enters this code into staff/redeem.html to apply the reward.
//
// We persist a `pendingRedemption` field on the member's record:
//   { code, rewardId, rewardName, points, expiresAt }
// Stored in members.json so the staff console (which has access to GitHub)
// can verify and decrement.
// ============================================================================
const crypto = require('crypto');
const https = require('https');

const SECRET = process.env.MEMBER_AUTH_SECRET || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const CLAIM_TTL_MS = 5 * 60 * 1000;

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
    if (Date.now() - parseInt(issuedStr, 10) > 30 * 24 * 3600 * 1000) return null;
    return { email, issued: parseInt(issuedStr, 10) };
  } catch (_) { return null; }
}

function genClaimCode() {
  // 6-character alphanumeric, no ambiguous chars (no 0/O/1/I/L)
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(0, alphabet.length)];
  return s;
}

function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: path,
      method: method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Redeem',
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

async function loadMembers() {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
  if (r.status !== 200) throw new Error('Could not load members.json');
  return { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
}

async function saveMembers(json, sha, msg) {
  const content = Buffer.from(JSON.stringify(json, null, 2)).toString('base64');
  const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', { message: msg, content: content, sha: sha });
  if (r.status !== 200 && r.status !== 201) throw new Error('Could not save members.json');
}

async function loadRewards() {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/rewards.json');
  if (r.status !== 200) return null;
  return JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return reply(405, { ok: false, error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const session = verifySessionToken(body.token || '');
  if (!session) return reply(401, { ok: false, error: 'Sign in first' });

  const rewardId = body.rewardId;
  if (!rewardId) return reply(400, { ok: false, error: 'rewardId required' });

  // Look up the reward + the member
  const rewards = await loadRewards();
  if (!rewards || !Array.isArray(rewards.catalog)) return reply(500, { ok: false, error: 'Could not load rewards catalog' });
  const reward = rewards.catalog.find((r) => r.id === rewardId);
  if (!reward || reward.active === false) return reply(404, { ok: false, error: 'Reward not available' });

  const file = await loadMembers();
  const memberIdx = (file.json.members || []).findIndex((m) => (m.email || '').toLowerCase() === session.email);
  if (memberIdx < 0) return reply(404, { ok: false, error: 'Member not found' });

  const member = file.json.members[memberIdx];
  if ((member.currentPoints || 0) < reward.points) {
    return reply(400, { ok: false, error: 'Not enough points', need: reward.points, have: member.currentPoints || 0 });
  }

  // Generate claim code (regenerate if collision — extremely unlikely)
  let code;
  for (let i = 0; i < 5; i++) {
    code = genClaimCode();
    const collision = file.json.members.some((m) => m.pendingRedemption && m.pendingRedemption.code === code && new Date(m.pendingRedemption.expiresAt).getTime() > Date.now());
    if (!collision) break;
  }

  const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
  // DEDUCT points immediately on confirm — customer commits at this step.
  // Code generation IS the point-spending action; bartender claim is just audit.
  member.currentPoints = (member.currentPoints || 0) - reward.points;
  member.history = member.history || [];
  member.history.push({
    at: new Date().toISOString(),
    action: 'redeem',
    rewardId: reward.id,
    rewardName: reward.name,
    delta: -reward.points,
    code: code,
    note: 'Redeemed via app — code generated for bartender',
  });
  member.totalRedemptions = (member.totalRedemptions || 0) + 1;
  member.pendingRedemption = {
    code: code,
    rewardId: reward.id,
    rewardName: reward.name,
    points: reward.points,
    initiatedAt: new Date().toISOString(),
    expiresAt: expiresAt,
  };
  file.json.lastUpdated = new Date().toISOString().split('T')[0];

  try {
    await saveMembers(file.json, file.sha, 'redeem-init: ' + member.email + ' wants ' + reward.name);
  } catch (e) {
    return reply(500, { ok: false, error: 'Save failed: ' + e.message });
  }

  return reply(200, {
    ok: true,
    code: code,
    rewardName: reward.name,
    rewardDescription: reward.description,
    points: reward.points,
    newBalance: member.currentPoints,
    expiresAt: expiresAt,
    expiresInSeconds: Math.round(CLAIM_TTL_MS / 1000),
  });
};
