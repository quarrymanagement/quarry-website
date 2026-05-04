// ============================================================================
// scan-review.js — admin approve/reject for flagged receipt scans
//
// POST { adminPassword, itemId, action }
//   action: "approve" → credit points, mark approved
//   action: "reject"  → mark rejected (no points), keep in ledger for audit
//
// Approved scans: appends to credited-orders.json so the same receipt can't
// be re-scanned. Same point math as scan-receipt.js.
//
// ENV: GITHUB_TOKEN, ADMIN_PASSWORD_HASH (or quarry2026 fallback)
// ============================================================================
const crypto = require('crypto');
const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const MIN_TAB_USD = 20;

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
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Scan-Review',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}'), raw: d }); }
        catch (_) { resolve({ status: res.statusCode, data: d, raw: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function loadJson(filePath) {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/' + filePath);
  if (r.status === 404) return { sha: null, json: null };
  if (r.status !== 200) throw new Error('GitHub load: HTTP ' + r.status);
  return { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
}

async function saveJson(filePath, json, sha, message) {
  const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64');
  const body = sha ? { message, content, sha } : { message, content };
  const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/' + filePath, body);
  if (r.status !== 200 && r.status !== 201) throw new Error('GitHub save: HTTP ' + r.status);
  return r.data.content && r.data.content.sha;
}

function tierMult(tier) {
  return ({ standard: 1.0, silver: 1.1, gold: 1.25, elite: 1.5, platinum: 1.5 }[tier]) || 1.0;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const { adminPassword, itemId, action } = body;
  if (!checkAdmin(adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });
  if (!itemId || !['approve','reject'].includes(action)) return reply(400, { ok: false, error: 'Missing itemId or invalid action' });

  // Load flagged queue
  const flaggedFile = await loadJson('scanned-flagged.json');
  if (!flaggedFile.json) return reply(404, { ok: false, error: 'No flagged queue' });
  const idx = flaggedFile.json.items.findIndex((x) => x.id === itemId);
  if (idx < 0) return reply(404, { ok: false, error: 'Flagged item not found' });
  const item = flaggedFile.json.items[idx];
  if (item.status !== 'pending') return reply(400, { ok: false, error: 'Already ' + item.status });

  if (action === 'reject') {
    item.status = 'rejected';
    item.decidedAt = new Date().toISOString();
    await saveJson('scanned-flagged.json', flaggedFile.json, flaggedFile.sha,
      'reject flagged scan ' + itemId);
    return reply(200, { ok: true, action: 'rejected' });
  }

  // ── APPROVE: credit points + add to ledger ──

  // Check ledger first to ensure not already credited
  const creditedFile = await loadJson('credited-orders.json');
  const credited = creditedFile.json || { orders: [] };
  if (credited.orders.some((o) => o.orderId === item.orderId)) {
    item.status = 'duplicate';
    item.decidedAt = new Date().toISOString();
    await saveJson('scanned-flagged.json', flaggedFile.json, flaggedFile.sha,
      'mark duplicate ' + itemId);
    return reply(400, { ok: false, error: 'Order already credited to another member' });
  }

  // Load member
  const membersFile = await loadJson('members.json');
  if (!membersFile.json) return reply(500, { ok: false, error: 'Members file missing' });
  const member = (membersFile.json.members || []).find(
    (x) => (x.email || '').toLowerCase() === (item.memberEmail || '').toLowerCase()
  );
  if (!member) return reply(404, { ok: false, error: 'Member not found' });

  // Compute points
  const tier = member.tier || 'standard';
  const mult = tierMult(tier);
  const basePts = Math.round(item.total * 10);
  const visitBonus = item.total >= MIN_TAB_USD ? 10 : 0;
  const totalPts = Math.round((basePts + visitBonus) * mult);

  // Update member
  member.currentPoints = (member.currentPoints || 0) + totalPts;
  member.lifetimePoints = (member.lifetimePoints || 0) + totalPts;
  member.lastVisitAt = new Date().toISOString();
  member.history = member.history || [];
  member.history.push({
    at: new Date().toISOString(),
    action: 'earn',
    source: 'receipt-scan-approved',
    delta: totalPts,
    orderId: item.orderId,
    checkNumber: item.checkNumber,
    spendUsd: item.total,
    tier,
    multiplier: mult,
    note: 'Admin-approved flagged scan',
  });

  await saveJson('members.json', membersFile.json, membersFile.sha,
    `+${totalPts} pts (admin-approved scan) — ${member.email}`);

  // Append to credited-orders ledger
  credited.orders.push({
    orderId: item.orderId,
    checkNumber: item.checkNumber,
    memberEmail: member.email,
    total: item.total,
    points: totalPts,
    creditedAt: new Date().toISOString(),
    approvedFromFlag: itemId,
  });
  await saveJson('credited-orders.json', credited, creditedFile.sha,
    `credit (admin) ${item.checkNumber} → ${member.email}`);

  // Mark flag as approved
  item.status = 'approved';
  item.decidedAt = new Date().toISOString();
  item.creditedPoints = totalPts;
  await saveJson('scanned-flagged.json', flaggedFile.json, flaggedFile.sha,
    'approve flagged scan ' + itemId);

  return reply(200, { ok: true, action: 'approved', points: totalPts, newBalance: member.currentPoints });
};
