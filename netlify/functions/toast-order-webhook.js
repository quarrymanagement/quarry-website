// ============================================================================
// toast-order-webhook.js
//
// Receives Toast webhook events for closed/updated orders and credits points
// to matching Quarry members in members.json based on rewards.json earn rate
// and tier multipliers.
//
// Toast → POST → /.netlify/functions/toast-order-webhook
//                 → look up member by email (primary) or phone (fallback)
//                 → calculate points = total × earnRate × tierMultiplier
//                 → update members.json on GitHub (idempotent — Toast retries
//                   the same orderId won't double-credit)
//
// SETUP — see TOAST_SETUP.md for the step-by-step.
//
// REQUIRED ENV VARS (set in Netlify):
//   TOAST_WEBHOOK_SECRET  HMAC secret Toast signs payloads with (recommended).
//                         Leave empty during initial testing to skip verification.
//   GITHUB_TOKEN          Already set; used to read/write members.json.
// ============================================================================

const crypto = require('crypto');
const https = require('https');

const GITHUB_REPO   = 'quarrymanagement/quarry-website';
const MEMBERS_PATH  = 'members.json';
const REWARDS_PATH  = 'rewards.json';
const DEFAULT_EARN_RATE = 10;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Toast-Webhook-Signature, X-Toast-Signature',
  'Content-Type': 'application/json',
};
const reply = (status, obj) => ({ statusCode: status, headers: CORS, body: JSON.stringify(obj) });

// ─── Toast signature verification ───────────────────────────────────────────
function verifySig(rawBody, signatureHeader, secret) {
  if (!secret) return true;                  // dev mode — skip
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');
  if (expected.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

// ─── Minimal GitHub API client ──────────────────────────────────────────────
function gh(method, path, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return Promise.reject(new Error('GITHUB_TOKEN not configured'));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'Quarry-Toast-Webhook',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }); }
        catch (_) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function loadJson(filePath) {
  const r = await gh('GET', `/repos/${GITHUB_REPO}/contents/${filePath}`);
  if (r.status !== 200) throw new Error(`Failed to load ${filePath}: HTTP ${r.status}`);
  return {
    sha: r.data.sha,
    json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')),
  };
}

async function saveJson(filePath, json, sha, message) {
  const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64');
  const r = await gh('PUT', `/repos/${GITHUB_REPO}/contents/${filePath}`, { message, content, sha });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`Failed to save ${filePath}: HTTP ${r.status} — ${JSON.stringify(r.data)}`);
  }
  return r.data.content && r.data.content.sha;
}

// ─── Member matching + point math ───────────────────────────────────────────
function findMember(members, customer) {
  if (!customer) return null;
  const email = (customer.email || '').toLowerCase().trim();
  if (email) {
    const m = members.find((x) => (x.email || '').toLowerCase() === email);
    if (m) return m;
  }
  // Phone match — compare last 10 digits to handle formatting differences
  const phone = (customer.phone || '').replace(/\D/g, '').slice(-10);
  if (phone && phone.length === 10) {
    return members.find((x) => (x.phone || '').replace(/\D/g, '').slice(-10) === phone);
  }
  return null;
}

function pointsFor(amountDollars, member, rewards) {
  const earnRate = (rewards && rewards.earnRate) || DEFAULT_EARN_RATE;
  let mult = 1;
  if (rewards && Array.isArray(rewards.tiers) && member.tier) {
    const t = rewards.tiers.find((x) => x.id === member.tier);
    if (t && t.earnMultiplier) mult = t.earnMultiplier;
  }
  return Math.max(0, Math.round(amountDollars * earnRate * mult));
}

function recalcTier(lifetimePts, rewards) {
  if (!rewards || !Array.isArray(rewards.tiers) || !rewards.tiers.length) {
    if (lifetimePts >= 6000) return 'platinum';
    if (lifetimePts >= 3000) return 'gold';
    return 'standard';
  }
  // Highest tier whose minPoints threshold is crossed
  const sorted = [...rewards.tiers].sort((a, b) => (b.minPoints || 0) - (a.minPoints || 0));
  for (const t of sorted) {
    if (lifetimePts >= (t.minPoints || 0)) return t.id;
  }
  return rewards.tiers[0].id;
}

// Toast occasionally sends amounts in cents (large integers). Normalize to dollars.
function extractTotal(order) {
  const cand = order.totalAmount != null ? order.totalAmount
             : order.amount      != null ? order.amount
             : order.total       != null ? order.total : 0;
  if (typeof cand === 'number' && cand >= 1000 && Number.isInteger(cand)) return cand / 100;
  return Number(cand) || 0;
}

function extractCustomer(order) {
  const c = order.customer || order.customerInfo || order.diner || {};
  return {
    email: c.email || c.emailAddress || '',
    phone: c.phone || c.phoneNumber || '',
    name:  c.firstName ? `${c.firstName} ${c.lastName || ''}`.trim()
         : (c.name || c.displayName || ''),
  };
}

// ─── Main handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return reply(405, { ok: false, error: 'POST only' });

  // Signature
  const sig = event.headers['toast-webhook-signature']
           || event.headers['x-toast-signature']
           || event.headers['toast-signature']
           || '';
  if (!verifySig(event.body || '', sig, process.env.TOAST_WEBHOOK_SECRET || '')) {
    return reply(401, { ok: false, error: 'Invalid signature' });
  }

  // Parse
  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  // Toast wraps events differently across products. Recognize the common shapes.
  const eventType = payload.eventType || payload.type || payload.event || '';
  const looksLikeOrder = (
    /^(order|check)\.?(closed|updated|paid)$/i.test(eventType) ||
    eventType === 'OrderUpdated' || eventType === 'CheckClosed' ||
    payload.guid || payload.orderGuid
  );
  if (!looksLikeOrder) return reply(200, { ok: true, ignored: 'non-order event', eventType });

  const order = payload.order || payload.data || payload;
  const orderId = order.guid || order.orderGuid || order.id || 'unknown';
  const customer = extractCustomer(order);

  if (!customer.email && !customer.phone) {
    return reply(200, { ok: true, skipped: 'no customer identity', orderId });
  }

  const total = extractTotal(order);
  if (total <= 0) return reply(200, { ok: true, skipped: 'zero total', orderId });

  // Load state from GitHub
  let membersFile;
  try { membersFile = await loadJson(MEMBERS_PATH); }
  catch (e) {
    console.error('members load failed:', e.message);
    return reply(500, { ok: false, error: 'members load failed: ' + e.message });
  }

  let rewards = null;
  try { rewards = (await loadJson(REWARDS_PATH)).json; }
  catch (e) { console.warn('rewards.json load skipped:', e.message); }

  const member = findMember(membersFile.json.members || [], customer);
  if (!member) {
    console.log('UNMATCHED ORDER', orderId, 'identity:', customer.email || customer.phone);
    return reply(200, { ok: true, unmatched: customer.email || customer.phone, orderId });
  }

  // Idempotency — Toast retries on 5xx so guard against double-credits
  member.history = member.history || [];
  const already = member.history.find((h) => h.orderId === orderId && h.action === 'earn');
  if (already) return reply(200, { ok: true, skipped: 'already credited', orderId, memberId: member.id });

  // Award + tier-up
  const earned = pointsFor(total, member, rewards);
  const oldTier = member.tier || 'standard';
  member.currentPoints  = (member.currentPoints  || 0) + earned;
  member.lifetimePoints = (member.lifetimePoints || 0) + earned;
  member.tier           = recalcTier(member.lifetimePoints, rewards);
  member.lastVisitAt    = new Date().toISOString();
  member.history.push({
    at: new Date().toISOString(),
    action: 'earn',
    delta: earned,
    by: 'toast-webhook',
    note: `$${total.toFixed(2)} order ${orderId}`,
    orderId,
  });
  if (oldTier !== member.tier) {
    member.history.push({
      at: new Date().toISOString(),
      action: 'tier-change',
      delta: 0,
      by: 'toast-webhook',
      note: `${oldTier} → ${member.tier}`,
    });
  }

  membersFile.json.lastUpdated = new Date().toISOString().split('T')[0];
  try {
    await saveJson(
      MEMBERS_PATH,
      membersFile.json,
      membersFile.sha,
      `members: +${earned} pts to ${member.name} (Toast order ${String(orderId).slice(0, 8)})`
    );
  } catch (e) {
    return reply(500, { ok: false, error: 'save failed: ' + e.message });
  }

  return reply(200, {
    ok: true,
    earned,
    orderId,
    memberId: member.id,
    memberEmail: member.email,
    newBalance: member.currentPoints,
    lifetimePoints: member.lifetimePoints,
    tier: member.tier,
    tierChanged: oldTier !== member.tier,
  });
};
