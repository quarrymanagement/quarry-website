// ============================================================================
// simulate-visit.js — admin-only test tool that mimics a real Toast-closed-tab
// visit end-to-end: credits points, applies birthday-bonus if applicable, runs
// the tier recalc, and (most importantly) fires the "Thanks for your visit"
// email so the actual format can be eyeballed in an inbox before launch.
//
// POST {
//   adminPassword,
//   memberEmail,         // existing rewards member
//   amountDollars,       // visit total — points = amount × earnRate × tierMult
//   dryRun?: true        // optional: show what would happen, don't write
// }
//
// Mirrors toast-order-webhook's credit-and-email path, with a synthetic
// orderId so it won't collide with a real Toast order. Safe to run as often
// as you want — each call uses a fresh orderId so dedup never trips.
//
// ENV: ADMIN_PASSWORD_HASH (optional), GITHUB_TOKEN, SENDGRID_API_KEY
// ============================================================================
const crypto = require('crypto');
const https  = require('https');
const { wrap } = require('./_sentry');

const GITHUB_TOKEN        = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO         = 'quarrymanagement/quarry-website';
const SENDGRID_KEY        = process.env.SENDGRID_API_KEY || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

const DEFAULT_EARN_RATE = 10;
const BIRTHDAY_BONUS    = 250;
const TIER_ORDER_BY_PTS = [
  { id: 'elite',    min: 6000 },
  { id: 'gold',     min: 3000 },
  { id: 'silver',   min: 1000 },
  { id: 'standard', min: 0    },
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b, null, 2) });

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
        'User-Agent': 'Quarry-Simulate-Visit',
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

function pointsFor(amountDollars, tier, rewards) {
  const earnRate = (rewards && rewards.earnRate) || DEFAULT_EARN_RATE;
  let mult = 1;
  if (rewards && Array.isArray(rewards.tiers)) {
    const t = rewards.tiers.find((x) => x.id === tier);
    if (t && t.earnMultiplier) mult = t.earnMultiplier;
  }
  return Math.max(0, Math.round(amountDollars * earnRate * mult));
}

// Promotion-only: compute trailing-90d spend and only return a HIGHER tier
// than the member currently has. Downgrades belong to expire-tiers.js.
function computeTrailingSpend(member, windowDays) {
  const cutoff = Date.now() - (windowDays * 24 * 60 * 60 * 1000);
  let total = 0;
  for (const h of (member.history || [])) {
    if (h.action !== 'earn' || !h.spendUsd) continue;
    const t = new Date(h.at).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    total += Number(h.spendUsd) || 0;
  }
  return total;
}
function recalcTier(member, rewards) {
  const ORDER = ['standard', 'silver', 'gold', 'elite'];
  const currentIdx = Math.max(0, ORDER.indexOf(member.tier || 'standard'));
  if (!rewards || !Array.isArray(rewards.tiers) || !rewards.tiers.length) {
    return member.tier || 'standard';
  }
  const window = rewards.tierWindowDays || 90;
  const trailingSpend = computeTrailingSpend(member, window);
  const sorted = [...rewards.tiers].sort((a, b) => (b.trailingSpendUsd || 0) - (a.trailingSpendUsd || 0));
  let earned = member.tier || 'standard';
  for (const t of sorted) {
    if (trailingSpend >= (t.trailingSpendUsd || 0)) { earned = t.id; break; }
  }
  const earnedIdx = Math.max(0, ORDER.indexOf(earned));
  return earnedIdx > currentIdx ? earned : (member.tier || 'standard');
}

// ── Visit-confirmation email (identical layout to toast-order-webhook) ─────
async function sendVisitEmail({ member, visitAmount, basePoints, birthdayBonus, newTier, oldTier, tierChanged }) {
  if (!SENDGRID_KEY || !member.email) return { skipped: true };
  const firstName = (member.name || member.email).split(/[\s@]/)[0] || 'Friend';
  const totalPts = basePoints + (birthdayBonus || 0);
  const formattedAmount = '$' + Number(visitAmount).toFixed(2);
  const tierLabel = (newTier || 'standard').charAt(0).toUpperCase() + (newTier || 'standard').slice(1);
  const balance = (member.currentPoints || 0).toLocaleString();
  const lifetime = (member.lifetimePoints || 0).toLocaleString();

  // Palette: white / black / gold (matches toast-order-webhook.js)
  const bdayBlock = birthdayBonus > 0
    ? '<div style="background:#FBF7EE;border:1px solid #D4AF6A;padding:14px 18px;margin:16px 0;border-radius:6px;text-align:center;">' +
        '<div style="font-size:0.7rem;letter-spacing:0.25em;color:#B8933A;margin-bottom:4px;">🎂 BIRTHDAY-MONTH BONUS</div>' +
        '<div style="font-size:1rem;color:#1A1A1A;">An extra <strong style="color:#B8933A">+' + birthdayBonus + ' points</strong> because it\'s your birthday month. Cheers, ' + firstName + '.</div>' +
      '</div>'
    : '';
  const tierBlock = tierChanged
    ? '<div style="background:#FBF7EE;border:1px solid #B8933A;padding:14px 18px;margin:16px 0;border-radius:6px;text-align:center;">' +
        '<div style="font-size:0.7rem;letter-spacing:0.25em;color:#B8933A;margin-bottom:4px;">⬆ TIER PROMOTION</div>' +
        '<div style="font-size:1rem;color:#1A1A1A;">You just crossed into <strong>' + tierLabel + '</strong>. New perks unlocked.</div>' +
      '</div>'
    : '';

  const html =
    '<div style="font-family:Georgia,serif;max-width:520px;margin:40px auto;padding:36px;background:#FFFFFF;color:#1A1A1A;border-radius:8px;border:1px solid #E8E0D0;">' +
      '<div style="text-align:center;font-size:0.7rem;letter-spacing:0.32em;color:#B8933A;margin-bottom:22px;">THE QUARRY · NEW MELLE · MO</div>' +
      '<h1 style="font-size:1.6rem;text-align:center;color:#1A1A1A;font-weight:600;margin-bottom:8px;">Thanks for visiting, ' + firstName + '.</h1>' +
      '<div style="text-align:center;font-style:italic;color:#777777;margin-bottom:28px;">It was good to have you in.</div>' +
      '<div style="border:1px solid #E8E0D0;border-radius:6px;padding:22px;margin:24px 0;text-align:center;font-family:Arial,sans-serif;">' +
        '<div style="font-size:0.65rem;letter-spacing:0.3em;color:#888888;text-transform:uppercase;margin-bottom:10px;">This visit</div>' +
        '<div style="font-size:1rem;color:#555555;margin-bottom:14px;">Tab total: <strong style="color:#1A1A1A">' + formattedAmount + '</strong></div>' +
        '<div style="font-size:2.4rem;font-weight:600;color:#B8933A;letter-spacing:0.04em;">+' + totalPts + '</div>' +
        '<div style="font-size:0.75rem;letter-spacing:0.18em;color:#888888;text-transform:uppercase;margin-top:4px;">points earned</div>' +
        (basePoints !== totalPts
          ? '<div style="font-size:0.7rem;color:#999999;margin-top:10px;">(' + basePoints + ' from your tab + ' + (birthdayBonus || 0) + ' bonus)</div>'
          : '') +
      '</div>' +
      bdayBlock +
      tierBlock +
      '<div style="display:table;width:100%;margin:24px 0;font-family:Arial,sans-serif;">' +
        '<div style="display:table-row;">' +
          '<div style="display:table-cell;width:50%;padding:14px;border:1px solid #E8E0D0;text-align:center;">' +
            '<div style="font-size:0.6rem;letter-spacing:0.22em;color:#888888;text-transform:uppercase;margin-bottom:6px;">Balance</div>' +
            '<div style="font-size:1.35rem;color:#1A1A1A;font-weight:600;">' + balance + '</div>' +
          '</div>' +
          '<div style="display:table-cell;width:50%;padding:14px;border:1px solid #E8E0D0;border-left:0;text-align:center;">' +
            '<div style="font-size:0.6rem;letter-spacing:0.22em;color:#888888;text-transform:uppercase;margin-bottom:6px;">' + tierLabel + ' tier · Lifetime</div>' +
            '<div style="font-size:1.35rem;color:#B8933A;font-weight:600;">' + lifetime + '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="text-align:center;margin:32px 0 12px;">' +
        '<a href="https://thequarrystl.com/quarry-app-customized.html" style="display:inline-block;padding:14px 32px;background:#1A1A1A;border:1px solid #1A1A1A;color:#D4AF6A;font-size:0.78rem;letter-spacing:0.22em;text-transform:uppercase;text-decoration:none;font-family:Arial,sans-serif;">View Your Rewards</a>' +
      '</div>' +
      '<div style="margin-top:24px;font-size:0.7rem;color:#999999;text-align:center;font-style:italic;">[Test email triggered via /simulate-visit · safe to ignore]</div>' +
      '<div style="margin-top:18px;padding-top:18px;border-top:1px solid #E8E0D0;font-size:0.7rem;color:#888888;text-align:center;font-family:Arial,sans-serif;">3960 Highway Z · New Melle, MO 63365 · (636) 224-8257</div>' +
    '</div>';

  const payload = JSON.stringify({
    personalizations: [{ to: [{ email: member.email }] }],
    from: { email: 'management@thequarrystl.com', name: 'The Quarry' },
    subject: '[TEST] Thanks for your visit — ' + totalPts + ' points earned',
    categories: ['quarry-visit-confirmation', 'simulate-visit-test'],
    content: [{ type: 'text/html', value: html }],
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SENDGRID_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 200) }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(payload);
    req.end();
  });
}

// ─── Handler ────────────────────────────────────────────────────────────────
exports.handler = wrap('simulate-visit', async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'auth' });

  const memberEmail = String(body.memberEmail || '').toLowerCase().trim();
  const amountDollars = Number(body.amountDollars);
  if (!memberEmail) return reply(400, { ok: false, error: 'memberEmail required' });
  if (!Number.isFinite(amountDollars) || amountDollars <= 0) return reply(400, { ok: false, error: 'amountDollars must be > 0' });

  const dryRun = !!body.dryRun;
  if (!GITHUB_TOKEN) return reply(500, { ok: false, error: 'GITHUB_TOKEN not configured' });

  // Load members + rewards
  let mFile, rewards = null;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('members.json: HTTP ' + r.status);
    mFile = { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
  } catch (e) { return reply(500, { ok: false, error: 'Could not load members: ' + e.message }); }
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/rewards.json');
    if (r.status === 200) rewards = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  } catch (_) { /* defaults */ }

  const member = (mFile.json.members || []).find((m) => (m.email || '').toLowerCase() === memberEmail);
  if (!member) return reply(404, { ok: false, error: 'No member found for ' + memberEmail });

  const oldTier = member.tier || 'standard';
  const pointsEarned = pointsFor(amountDollars, oldTier, rewards);

  // Birthday-month bonus (mirror toast-order-webhook)
  let birthdayBonus = 0;
  if (member.birthday && /^\d{4}-\d{2}-\d{2}$/.test(member.birthday)) {
    const nowDate = new Date();
    if (nowDate.getUTCMonth() + 1 === parseInt(member.birthday.slice(5, 7), 10)) {
      const yr = nowDate.getUTCFullYear();
      const already = (member.history || []).some((h) =>
        h.action === 'earn' && h.source === 'birthday-month' && h.year === yr
      );
      if (!already) birthdayBonus = BIRTHDAY_BONUS;
    }
  }

  // Mutate (in-memory only if dryRun)
  const now = new Date().toISOString();
  const orderId = 'sim-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  member.currentPoints  = (member.currentPoints || 0) + pointsEarned + birthdayBonus;
  member.lifetimePoints = (member.lifetimePoints || 0) + pointsEarned + birthdayBonus;
  member.lastVisitAt    = now;
  member.tierWarnedAt   = null;
  member.history = member.history || [];
  member.history.push({
    at: now, action: 'earn', source: 'simulate-visit', orderId,
    delta: pointsEarned, spendUsd: amountDollars, tier: oldTier,
    note: '[TEST] Simulated visit: $' + amountDollars.toFixed(2),
  });
  if (birthdayBonus > 0) {
    member.history.push({
      at: now, action: 'earn', source: 'birthday-month',
      delta: birthdayBonus, year: new Date().getUTCFullYear(),
      note: '[TEST] Simulated birthday-month bonus',
    });
  }
  const newTier = recalcTier(member, rewards);
  const tierChanged = newTier !== oldTier;
  if (tierChanged) {
    member.tier = newTier;
    member.history.push({
      at: now, action: 'tier-promotion', from: oldTier, to: newTier,
      by: 'auto', note: '[TEST] Simulated promotion via simulate-visit',
    });
  }

  if (!dryRun) {
    mFile.json.lastUpdated = now.split('T')[0];
    try {
      const content = Buffer.from(JSON.stringify(mFile.json, null, 2), 'utf8').toString('base64');
      const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
        message: '[sim] +' + (pointsEarned + birthdayBonus) + ' pts ' + (tierChanged ? '→ ' + newTier : '') + ' (' + memberEmail + ')',
        content, sha: mFile.sha,
      });
      if (r.status !== 200 && r.status !== 201) throw new Error('Save: HTTP ' + r.status);
    } catch (e) { return reply(500, { ok: false, error: 'Save failed: ' + e.message }); }
  }

  // Send the visit-confirmation email (the whole point of this endpoint)
  const emailResult = await sendVisitEmail({
    member, visitAmount: amountDollars, basePoints: pointsEarned,
    birthdayBonus, newTier, oldTier, tierChanged,
  });

  return reply(200, {
    ok: true,
    dryRun,
    orderId,
    memberEmail,
    pointsEarned,
    birthdayBonus,
    totalPointsThisVisit: pointsEarned + birthdayBonus,
    newBalance: member.currentPoints,
    lifetimePoints: member.lifetimePoints,
    oldTier, newTier, tierChanged,
    emailResult,
  });
});
