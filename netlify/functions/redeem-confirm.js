// ============================================================================
// redeem-confirm.js — staff confirms a pending redemption (step 2 of 2)
//
// Staff opens /staff, types or scans the customer's 6-digit code, and confirms
// the reward. We then:
//   1. Re-verify the member has enough points (in case of race condition)
//   2. Deduct points from members.json (currentPoints -= reward.points)
//   3. Write a 'redeem' history entry on the member
//   4. Mark the pending redemption blob as 'confirmed' with new balance
//   5. The customer's app, which is polling redeem-status, sees the flip
//      and shows the "Redeemed — show staff" screen.
//
// POST { code, adminPassword, staffName? }
//   → { ok: true, member, reward, newBalance, points }
//   → 401 if auth fails
//   → 404 if code not found
//   → 410 if expired
//   → 409 if already confirmed
//   → 400 if insufficient points (rare race)
//
// ENV: GITHUB_TOKEN, ADMIN_PASSWORD_HASH, ADMIN_SESSION_SECRET
// ============================================================================
const crypto = require('crypto');
const https  = require('https');
const { wrap } = require('./_sentry');
const { readBlob, writeBlob } = require('./_blobs');

const GITHUB_TOKEN          = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO           = 'quarrymanagement/quarry-website';
const ADMIN_PASSWORD_HASH   = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_SESSION_SECRET  = process.env.ADMIN_SESSION_SECRET || '';
const SESSION_TTL_HOURS     = 168;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }

function checkPassword(p) {
  if (!p) return false;
  if (ADMIN_PASSWORD_HASH) return sha256(p) === ADMIN_PASSWORD_HASH;
  return p === 'quarry2026';
}
function checkToken(token) {
  if (!ADMIN_SESSION_SECRET || !token) return false;
  const [issued, sig] = String(token).split('.');
  if (!issued || !sig) return false;
  if (hmac(issued, ADMIN_SESSION_SECRET) !== sig) return false;
  const ageHours = (Date.now() - parseInt(issued, 10)) / (1000 * 3600);
  return ageHours < SESSION_TTL_HOURS;
}
function checkAdmin({ password, token }) {
  if (token && checkToken(token)) return true;
  if (password && checkPassword(password)) return true;
  return false;
}

function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Redeem-Confirm',
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

exports.handler = wrap('redeem-confirm', async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  if (!GITHUB_TOKEN) return reply(500, { ok: false, error: 'GITHUB_TOKEN not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin({ password: body.adminPassword, token: body.adminToken })) {
    return reply(401, { ok: false, error: 'Auth required' });
  }

  const code = String(body.code || '').toUpperCase().trim();
  const staffName = String(body.staffName || '').slice(0, 60);
  if (!code) return reply(400, { ok: false, error: 'code required' });

  const pending = await readBlob('redemptions/' + code);
  if (!pending) return reply(404, { ok: false, error: 'Code not found' });

  if (pending.status === 'confirmed') {
    return reply(409, { ok: false, error: 'Already confirmed', confirmedAt: pending.confirmedAt });
  }
  if (pending.expiresAt && new Date(pending.expiresAt).getTime() < Date.now()) {
    return reply(410, { ok: false, error: 'Code expired' });
  }

  // Load members.json and re-verify balance, then deduct
  let mFile;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    mFile = { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
  } catch (e) {
    return reply(500, { ok: false, error: 'Could not load members.json: ' + e.message });
  }

  const member = (mFile.json.members || []).find((m) => (m.email || '').toLowerCase() === (pending.memberEmail || '').toLowerCase());
  if (!member) return reply(404, { ok: false, error: 'Member missing — was the account deleted?' });

  const pointsCost = Number(pending.points) || 0;
  const balanceBefore = Number(member.currentPoints) || 0;
  if (balanceBefore < pointsCost) {
    return reply(400, {
      ok: false, error: 'Member no longer has enough points',
      have: balanceBefore, need: pointsCost,
    });
  }

  const now = new Date().toISOString();
  member.currentPoints = balanceBefore - pointsCost;
  member.history = member.history || [];
  member.history.push({
    at: now,
    action: 'redeem',
    source: 'staff-confirm',
    delta: -pointsCost,
    rewardId: pending.rewardId || '',
    rewardName: pending.rewardName || '',
    code,
    by: staffName ? ('staff:' + staffName) : 'staff',
    note: 'Redeemed: ' + (pending.rewardName || pending.rewardId),
  });
  mFile.json.lastUpdated = now.split('T')[0];

  try {
    const content = Buffer.from(JSON.stringify(mFile.json, null, 2), 'utf8').toString('base64');
    const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
      message: '[redeem] -' + pointsCost + ' pts (' + (pending.rewardName || pending.rewardId) + ') ' + (pending.memberEmail || ''),
      content, sha: mFile.sha,
    });
    if (r.status !== 200 && r.status !== 201) throw new Error('HTTP ' + r.status);
  } catch (e) {
    return reply(500, { ok: false, error: 'Save failed: ' + e.message });
  }

  // Flip the blob to confirmed so the customer's poll sees it
  const updatedBlob = Object.assign({}, pending, {
    status: 'confirmed',
    confirmedAt: now,
    confirmedBy: staffName || 'staff',
    newBalance: member.currentPoints,
  });
  await writeBlob('redemptions/' + code, updatedBlob);

  return reply(200, {
    ok: true,
    code,
    member: { email: pending.memberEmail, name: member.name || '' },
    reward: {
      id: pending.rewardId || '',
      name: pending.rewardName || '',
      description: pending.rewardDescription || '',
      points: pointsCost,
    },
    points: pointsCost,
    newBalance: member.currentPoints,
    confirmedAt: now,
  });
});
