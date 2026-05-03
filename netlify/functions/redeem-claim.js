// ============================================================================
// redeem-claim.js — bartender applies a redemption
//
// POST { adminPassword, code } → finds the member with that pendingRedemption,
//   validates expiry, decrements currentPoints, increments totalRedemptions,
//   logs to history, clears pendingRedemption, returns the redemption details.
//
// Auth: same admin password as the admin portal (legacy plaintext fallback
// for now — same behavior as verify-admin-password while ADMIN_PASSWORD_HASH
// is unset).
// ============================================================================
const crypto = require('crypto');
const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

function checkAdmin(password) {
  if (!password) return false;
  if (ADMIN_PASSWORD_HASH) return sha256(password) === ADMIN_PASSWORD_HASH;
  return password === 'quarry2026'; // legacy fallback
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return reply(405, { ok: false, error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin(body.adminPassword)) {
    return reply(401, { ok: false, error: 'Invalid admin password' });
  }

  const code = (body.code || '').toUpperCase().trim();
  if (code.length !== 6) return reply(400, { ok: false, error: 'Enter the 6-character code' });

  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
  if (r.status !== 200) return reply(500, { ok: false, error: 'Could not load members' });
  const json = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  const sha = r.data.sha;

  const memberIdx = (json.members || []).findIndex((m) => m.pendingRedemption && m.pendingRedemption.code === code);
  if (memberIdx < 0) return reply(404, { ok: false, error: 'Code not found or already used' });

  const member = json.members[memberIdx];
  const pr = member.pendingRedemption;

  if (new Date(pr.expiresAt).getTime() < Date.now()) {
    delete member.pendingRedemption; // clean up expired
    json.lastUpdated = new Date().toISOString().split('T')[0];
    const cleanContent = Buffer.from(JSON.stringify(json, null, 2)).toString('base64');
    await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
      message: 'redeem-claim: clean up expired code ' + code,
      content: cleanContent,
      sha: sha,
    });
    return reply(410, { ok: false, error: 'Code expired. Member needs to generate a new one.' });
  }

  if ((member.currentPoints || 0) < pr.points) {
    return reply(400, { ok: false, error: 'Member no longer has enough points (current: ' + (member.currentPoints || 0) + ')' });
  }

  // Apply
  member.currentPoints = (member.currentPoints || 0) - pr.points;
  member.totalRedemptions = (member.totalRedemptions || 0) + 1;
  member.history = member.history || [];
  member.history.push({
    at: new Date().toISOString(),
    action: 'redeem',
    delta: -pr.points,
    by: 'staff-redeem',
    note: pr.rewardName + ' (code ' + code + ')',
    rewardId: pr.rewardId,
  });
  delete member.pendingRedemption;
  json.lastUpdated = new Date().toISOString().split('T')[0];

  const content = Buffer.from(JSON.stringify(json, null, 2)).toString('base64');
  const put = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
    message: 'redeem: ' + member.name + ' used ' + pr.rewardName + ' (-' + pr.points + ' pts)',
    content: content,
    sha: sha,
  });
  if (put.status !== 200 && put.status !== 201) {
    return reply(500, { ok: false, error: 'Save failed: HTTP ' + put.status });
  }

  return reply(200, {
    ok: true,
    member: {
      name: member.name,
      email: member.email,
      tier: member.tier,
    },
    reward: {
      name: pr.rewardName,
      points: pr.points,
    },
    newBalance: member.currentPoints,
  });
};
