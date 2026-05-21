// ============================================================================
// redeem-create.js — customer-initiated reward redemption (step 1 of 2)
//
// Customer taps "Redeem" in the rewards app → we generate a short pending code
// (and verify they actually have enough points). Code is stored in Netlify
// Blobs with a 5-minute TTL. Staff confirms via redeem-confirm.js, which
// is where the actual points-deduction happens.
//
// We DO NOT deduct points here — only after staff confirms. This avoids the
// situation where a customer taps Redeem and then leaves without showing
// staff (their points would be gone for nothing).
//
// POST { memberEmail, rewardId }
//   → { ok: true, code: 'ABC123', expiresAt: <iso>, reward: { ... } }
//   → 400 if insufficient points
//   → 404 if member or reward not found
//
// ENV: GITHUB_TOKEN (read members.json + rewards.json)
// ============================================================================
const crypto = require('crypto');
const https  = require('https');
const { wrap } = require('./_sentry');
const { writeBlob } = require('./_blobs');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO  = 'quarrymanagement/quarry-website';
const CODE_TTL_MS  = 5 * 60 * 1000; // 5 minutes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function gh(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Redeem-Create',
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
    req.end();
  });
}

// Human-friendly 6-char alphanumeric code (avoid 0/O/1/I/L)
function makeCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[buf[i] % alphabet.length];
  return code;
}

exports.handler = wrap('redeem-create', async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  if (!GITHUB_TOKEN) return reply(500, { ok: false, error: 'GITHUB_TOKEN not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const memberEmail = String(body.memberEmail || '').toLowerCase().trim();
  const rewardId    = String(body.rewardId || '').trim();
  if (!memberEmail) return reply(400, { ok: false, error: 'memberEmail required' });
  if (!rewardId)    return reply(400, { ok: false, error: 'rewardId required' });

  // Load members + rewards
  let members, rewards;
  try {
    const [mRes, rRes] = await Promise.all([
      gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json'),
      gh('GET', '/repos/' + GITHUB_REPO + '/contents/rewards.json'),
    ]);
    if (mRes.status !== 200) throw new Error('members.json: HTTP ' + mRes.status);
    if (rRes.status !== 200) throw new Error('rewards.json: HTTP ' + rRes.status);
    members = JSON.parse(Buffer.from(mRes.data.content, 'base64').toString('utf8'));
    rewards = JSON.parse(Buffer.from(rRes.data.content, 'base64').toString('utf8'));
  } catch (e) {
    return reply(500, { ok: false, error: 'Load failed: ' + e.message });
  }

  const member = (members.members || []).find((m) => (m.email || '').toLowerCase() === memberEmail);
  if (!member) return reply(404, { ok: false, error: 'No member found for ' + memberEmail });

  const catalog = Array.isArray(rewards.catalog) ? rewards.catalog : [];
  const reward = catalog.find((r) => r.id === rewardId);
  if (!reward) return reply(404, { ok: false, error: 'Reward not found: ' + rewardId });
  if (reward.active === false) return reply(400, { ok: false, error: 'Reward not currently available' });

  const pointsCost = Number(reward.points) || 0;
  const balance    = Number(member.currentPoints) || 0;
  if (balance < pointsCost) {
    return reply(400, {
      ok: false, error: 'Insufficient points',
      have: balance, need: pointsCost, short: pointsCost - balance,
    });
  }

  // Make a pending-redemption blob. Retry up to 5 times if code collides.
  let code, written = false;
  for (let i = 0; i < 5 && !written; i++) {
    code = makeCode();
    const blob = {
      code,
      memberEmail,
      memberName: member.name || '',
      rewardId,
      rewardName: reward.name,
      rewardDescription: reward.description || '',
      points: pointsCost,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    };
    written = await writeBlob('redemptions/' + code, blob);
    if (!written) break; // hard error, not a collision
  }
  if (!written) return reply(500, { ok: false, error: 'Could not create redemption' });

  return reply(200, {
    ok: true,
    code,
    expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    reward: { id: reward.id, name: reward.name, description: reward.description, points: pointsCost },
    member: { name: member.name || '', balance },
  });
});
