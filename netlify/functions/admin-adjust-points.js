// ============================================================================
// admin-adjust-points.js — admin manually adds (or removes) points to a member
//
// POST { adminPassword, memberEmail, delta, note, source? }
//   delta: positive int to add, negative to remove
//   note:  free-text reason ("Walk-in didn't have receipt" / "Refund correction")
//   source (optional): a short label (defaults to "admin-adjust")
//
// Updates currentPoints + lifetimePoints (when adding only) and writes a
// detailed history entry that includes the admin who did it.
//
// ENV: GITHUB_TOKEN, ADMIN_PASSWORD_HASH (or quarry2026 fallback)
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
        'User-Agent': 'Quarry-Admin-Adjust',
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!GITHUB_TOKEN) return reply(500, { ok: false, error: 'Server not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });

  const memberEmail = String(body.memberEmail || '').trim().toLowerCase();
  const delta = parseInt(body.delta, 10);
  const note = String(body.note || '').trim();
  const source = String(body.source || 'admin-adjust');

  if (!memberEmail) return reply(400, { ok: false, error: 'memberEmail required' });
  if (!Number.isFinite(delta) || delta === 0) return reply(400, { ok: false, error: 'delta must be a non-zero integer' });
  if (Math.abs(delta) > 100000) return reply(400, { ok: false, error: 'delta too large; max 100,000' });
  if (!note) return reply(400, { ok: false, error: 'A reason/note is required for audit trail' });

  // Load members
  let mFile;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    mFile = { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
  } catch (e) { return reply(500, { ok: false, error: 'Could not load members.json: ' + e.message }); }

  const member = (mFile.json.members || []).find((x) => (x.email || '').toLowerCase() === memberEmail);
  if (!member) return reply(404, { ok: false, error: 'No member found for ' + memberEmail });

  // Disallow going negative
  const currentBefore = member.currentPoints || 0;
  if (delta < 0 && currentBefore + delta < 0) {
    return reply(400, { ok: false, error: 'Member only has ' + currentBefore + ' points; cannot deduct ' + Math.abs(delta) });
  }

  member.currentPoints = currentBefore + delta;
  // Adding to lifetime only on positive delta (don't reduce lifetime on a manual deduct)
  if (delta > 0) member.lifetimePoints = (member.lifetimePoints || 0) + delta;

  member.history = member.history || [];
  member.history.push({
    at: new Date().toISOString(),
    action: delta > 0 ? 'earn' : 'redeem',
    source,
    delta,
    by: 'admin',
    note,
  });
  mFile.json.lastUpdated = new Date().toISOString().split('T')[0];

  try {
    const content = Buffer.from(JSON.stringify(mFile.json, null, 2), 'utf8').toString('base64');
    const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
      message: (delta > 0 ? '+' : '') + delta + ' pts (admin) — ' + memberEmail + ': ' + note.substring(0, 60),
      content, sha: mFile.sha,
    });
    if (r.status !== 200 && r.status !== 201) throw new Error('HTTP ' + r.status);
  } catch (e) { return reply(500, { ok: false, error: 'Save failed: ' + e.message }); }

  return reply(200, {
    ok: true,
    memberEmail: member.email,
    delta,
    newBalance: member.currentPoints,
    lifetimePoints: member.lifetimePoints,
  });
};
