// ============================================================================
// toast-order-webhook.js  (v2 — adds tier-promotion email via SendGrid)
//
// Receives Toast webhook events for closed/updated orders and credits points
// to matching Quarry members in members.json. When a member crosses a tier
// threshold, fires a "Welcome to <tier>" email.
//
// ENV: TOAST_WEBHOOK_SECRET, GITHUB_TOKEN, SENDGRID_API_KEY (for tier emails)
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

function verifySig(rawBody, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  if (expected.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

function gh(method, path, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return Promise.reject(new Error('GITHUB_TOKEN not configured'));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'Quarry-Toast-Webhook',
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

async function loadJson(filePath) {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/' + filePath);
  if (r.status !== 200) throw new Error('Failed to load ' + filePath + ': HTTP ' + r.status);
  return { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
}

async function saveJson(filePath, json, sha, message) {
  const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64');
  const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/' + filePath, { message, content, sha });
  if (r.status !== 200 && r.status !== 201) throw new Error('Failed to save ' + filePath + ': HTTP ' + r.status);
  return r.data.content && r.data.content.sha;
}

function findMember(members, customer) {
  if (!customer) return null;
  const email = (customer.email || '').toLowerCase().trim();
  if (email) {
    const m = members.find((x) => (x.email || '').toLowerCase() === email);
    if (m) return m;
  }
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
  const sorted = [...rewards.tiers].sort((a, b) => (b.minPoints || 0) - (a.minPoints || 0));
  for (const t of sorted) {
    if (lifetimePts >= (t.minPoints || 0)) return t.id;
  }
  return rewards.tiers[0].id;
}

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
    name:  c.firstName ? (c.firstName + ' ' + (c.lastName || '')).trim()
         : (c.name || c.displayName || ''),
  };
}

// ─── Tier promotion email (fire-and-forget) ─────────────────────────────────
async function sendTierEmail(email, name, tier) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey || !email) return;

  const tierData = {
    gold: {
      label: 'Quarry Gold',
      blurb: 'You have crossed into Gold. Your earn rate jumps to 1.25× — you collect points 25% faster on every visit. You also get early access to event RSVPs and priority on busy nights.',
    },
    platinum: {
      label: 'Quarry Platinum',
      blurb: 'Welcome to the top tier. Your earn rate jumps to 1.5×. You are invited to hosted tastings throughout the year, and our team will personally help you book the holidays.',
    },
  };
  const data = tierData[tier];
  if (!data) return; // no email for demotion or for standard

  const firstName = (name || email).split(/[\s@]/)[0] || 'Friend';
  const body = JSON.stringify({
    personalizations: [{ to: [{ email }] }],
    from: { email: 'management@thequarrystl.com', name: 'The Quarry' },
    subject: 'Welcome to ' + data.label,
    content: [{
      type: 'text/html',
      value:
        '<div style="font-family:Georgia,\'Playfair Display\',serif;max-width:520px;margin:40px auto;padding:36px;background:#1A1A1A;color:#F5F0E8;border-radius:8px;">' +
          '<div style="text-align:center;font-size:0.7rem;letter-spacing:0.32em;color:#B8933A;margin-bottom:22px;">THE QUARRY · NEW MELLE · MO</div>' +
          '<h1 style="font-size:1.7rem;text-align:center;color:#F5F0E8;font-weight:600;margin-bottom:8px;">Welcome to ' + data.label + ', ' + firstName + '.</h1>' +
          '<div style="text-align:center;font-style:italic;color:rgba(245,240,232,0.6);margin-bottom:28px;">You have been promoted.</div>' +
          '<div style="font-size:0.95rem;line-height:1.7;color:rgba(245,240,232,0.85);margin-bottom:24px;font-family:Georgia,serif;">' + data.blurb + '</div>' +
          '<div style="text-align:center;margin-top:36px;"><a href="https://thequarrystl.com/quarry-app-customized.html" style="display:inline-block;padding:14px 32px;border:1px solid #B8933A;color:#D4AF6A;font-size:0.78rem;letter-spacing:0.22em;text-transform:uppercase;text-decoration:none;font-family:Arial,sans-serif;">Open the App</a></div>' +
          '<div style="margin-top:36px;padding-top:18px;border-top:1px solid rgba(196,149,106,0.15);font-size:0.7rem;color:rgba(245,240,232,0.4);text-align:center;">3960 Highway Z · New Melle, MO 63365 · (636) 224-8257</div>' +
        '</div>',
    }],
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.write(body);
    req.end();
  });
}

// ─── Main handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return reply(405, { ok: false, error: 'POST only' });

  const sig = event.headers['toast-webhook-signature']
           || event.headers['x-toast-signature']
           || event.headers['toast-signature']
           || '';
  if (!verifySig(event.body || '', sig, process.env.TOAST_WEBHOOK_SECRET || '')) {
    return reply(401, { ok: false, error: 'Invalid signature' });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

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

  let membersFile;
  try { membersFile = await loadJson(MEMBERS_PATH); }
  catch (e) { return reply(500, { ok: false, error: 'members load failed: ' + e.message }); }

  let rewards = null;
  try { rewards = (await loadJson(REWARDS_PATH)).json; } catch (_) { /* fall back to defaults */ }

  const member = findMember(membersFile.json.members || [], customer);
  if (!member) {
    console.log('UNMATCHED ORDER', orderId, 'identity:', customer.email || customer.phone);
    return reply(200, { ok: true, unmatched: customer.email || customer.phone, orderId });
  }

  member.history = member.history || [];
  const already = member.history.find((h) => h.orderId === orderId && h.action === 'earn');
  if (already) return reply(200, { ok: true