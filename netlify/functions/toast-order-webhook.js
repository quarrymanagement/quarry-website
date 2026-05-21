// ============================================================================
// toast-order-webhook.js  (v3 — birthday-month bonus + post-visit confirmation)
//
// Receives Toast webhook events for closed/updated orders and credits points
// to matching Quarry members in members.json. When a member crosses a tier
// threshold, fires a "Welcome to <tier>" email. Awards a +250 birthday-month
// bonus once per year on the first qualifying visit during the birth month.
// Sends a "thanks for your visit" email showing points earned and balance.
//
// ENV: TOAST_WEBHOOK_SECRET, GITHUB_TOKEN, SENDGRID_API_KEY
// ============================================================================
const crypto = require('crypto');
const https = require('https');
const { wrap } = require('./_sentry');

const BIRTHDAY_BONUS = 250;
// Throttle visit emails — no more than one per 6 hours per member so lunch
// + dinner on the same day don't double-send.
const VISIT_EMAIL_MIN_GAP_HOURS = 6;

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

// Compute tier from trailing-90-day spend, per rewards.json (trailingSpendUsd).
// PROMOTION-ONLY: never returns a tier lower than the member's current one —
// downgrades are owned by expire-tiers.js (60-day inactivity rule).
function computeTrailingSpend(member, windowDays) {
  const cutoff = Date.now() - (windowDays * 24 * 60 * 60 * 1000);
  let total = 0;
  for (const h of (member.history || [])) {
    if (h.action !== 'earn') continue;
    if (!h.spendUsd) continue;
    const t = new Date(h.at).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    total += Number(h.spendUsd) || 0;
  }
  return total;
}
function recalcTier(member, rewards) {
  const TIER_ORDER = ['standard', 'silver', 'gold', 'elite'];
  const currentIdx = Math.max(0, TIER_ORDER.indexOf(member.tier || 'standard'));
  if (!rewards || !Array.isArray(rewards.tiers) || !rewards.tiers.length) {
    return member.tier || 'standard';
  }
  const window = rewards.tierWindowDays || 90;
  const trailingSpend = computeTrailingSpend(member, window);
  // highest tier whose trailingSpendUsd threshold is met
  const sorted = [...rewards.tiers].sort((a, b) => (b.trailingSpendUsd || 0) - (a.trailingSpendUsd || 0));
  let earned = member.tier || 'standard';
  for (const t of sorted) {
    if (trailingSpend >= (t.trailingSpendUsd || 0)) { earned = t.id; break; }
  }
  // promotion-only: never return below current tier
  const earnedIdx = Math.max(0, TIER_ORDER.indexOf(earned));
  return earnedIdx > currentIdx ? earned : (member.tier || 'standard');
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

// ─── Visit confirmation email (fire-and-forget) ────────────────────────────
async function sendVisitEmail({ member, visitAmount, basePoints, birthdayBonus, newTier, oldTier, tierChanged }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey || !member.email) return;

  const firstName = (member.name || member.email).split(/[\s@]/)[0] || 'Friend';
  const totalPts = basePoints + (birthdayBonus || 0);
  const formattedAmount = '$' + Number(visitAmount).toFixed(2);
  const tierLabel = (newTier || 'standard').charAt(0).toUpperCase() + (newTier || 'standard').slice(1);
  const balance = (member.currentPoints || 0).toLocaleString();
  const lifetime = (member.lifetimePoints || 0).toLocaleString();

  const bdayBlock = birthdayBonus > 0
    ? '<div style="background:rgba(212,175,106,0.12);border:1px solid #B8933A;padding:14px 18px;margin:16px 0;border-radius:6px;text-align:center;">' +
        '<div style="font-size:0.7rem;letter-spacing:0.25em;color:#B8933A;margin-bottom:4px;">🎂 BIRTHDAY-MONTH BONUS</div>' +
        '<div style="font-size:1rem;color:#F5F0E8;">An extra <strong style="color:#D4AF6A">+' + birthdayBonus + ' points</strong> because it\'s your birthday month. Cheers, ' + firstName + '.</div>' +
      '</div>'
    : '';

  const tierBlock = tierChanged
    ? '<div style="background:rgba(212,175,106,0.18);border:1px solid #D4AF6A;padding:14px 18px;margin:16px 0;border-radius:6px;text-align:center;">' +
        '<div style="font-size:0.7rem;letter-spacing:0.25em;color:#D4AF6A;margin-bottom:4px;">⬆ TIER PROMOTION</div>' +
        '<div style="font-size:1rem;color:#F5F0E8;">You just crossed into <strong>' + tierLabel + '</strong>. New perks unlocked.</div>' +
      '</div>'
    : '';

  const body = JSON.stringify({
    personalizations: [{ to: [{ email: member.email }] }],
    from: { email: 'management@thequarrystl.com', name: 'The Quarry' },
    subject: 'Thanks for your visit — ' + totalPts + ' points earned',
    categories: ['quarry-visit-confirmation'],
    content: [{
      type: 'text/html',
      value:
        '<div style="font-family:Georgia,\'Playfair Display\',serif;max-width:520px;margin:40px auto;padding:36px;background:#1A1A1A;color:#F5F0E8;border-radius:8px;">' +
          '<div style="text-align:center;font-size:0.7rem;letter-spacing:0.32em;color:#B8933A;margin-bottom:22px;">THE QUARRY · NEW MELLE · MO</div>' +
          '<h1 style="font-size:1.6rem;text-align:center;color:#F5F0E8;font-weight:600;margin-bottom:8px;">Thanks for visiting, ' + firstName + '.</h1>' +
          '<div style="text-align:center;font-style:italic;color:rgba(245,240,232,0.6);margin-bottom:28px;font-family:Georgia,serif;">It was good to have you in.</div>' +

          '<div style="border:1px solid rgba(196,149,106,0.25);border-radius:6px;padding:22px;margin:24px 0;text-align:center;font-family:Arial,sans-serif;">' +
            '<div style="font-size:0.65rem;letter-spacing:0.3em;color:rgba(245,240,232,0.55);text-transform:uppercase;margin-bottom:10px;">This visit</div>' +
            '<div style="font-size:1rem;color:rgba(245,240,232,0.85);margin-bottom:14px;">Tab total: <strong style="color:#F5F0E8">' + formattedAmount + '</strong></div>' +
            '<div style="font-size:2.4rem;font-weight:600;color:#D4AF6A;letter-spacing:0.04em;">+' + totalPts + '</div>' +
            '<div style="font-size:0.75rem;letter-spacing:0.18em;color:rgba(245,240,232,0.5);text-transform:uppercase;margin-top:4px;">points earned</div>' +
            (basePoints !== totalPts
              ? '<div style="font-size:0.7rem;color:rgba(245,240,232,0.45);margin-top:10px;">(' + basePoints + ' from your tab + ' + (birthdayBonus || 0) + ' bonus)</div>'
              : '') +
          '</div>' +

          bdayBlock +
          tierBlock +

          '<div style="display:table;width:100%;margin:24px 0;font-family:Arial,sans-serif;">' +
            '<div style="display:table-row;">' +
              '<div style="display:table-cell;width:50%;padding:14px;border:1px solid rgba(196,149,106,0.18);text-align:center;">' +
                '<div style="font-size:0.6rem;letter-spacing:0.22em;color:rgba(245,240,232,0.5);text-transform:uppercase;margin-bottom:6px;">Balance</div>' +
                '<div style="font-size:1.35rem;color:#F5F0E8;font-weight:600;">' + balance + '</div>' +
              '</div>' +
              '<div style="display:table-cell;width:50%;padding:14px;border:1px solid rgba(196,149,106,0.18);border-left:0;text-align:center;">' +
                '<div style="font-size:0.6rem;letter-spacing:0.22em;color:rgba(245,240,232,0.5);text-transform:uppercase;margin-bottom:6px;">' + tierLabel + ' tier · Lifetime</div>' +
                '<div style="font-size:1.35rem;color:#D4AF6A;font-weight:600;">' + lifetime + '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div style="text-align:center;margin:32px 0 12px;">' +
            '<a href="https://thequarrystl.com/quarry-app-customized.html" style="display:inline-block;padding:14px 32px;border:1px solid #B8933A;color:#D4AF6A;font-size:0.78rem;letter-spacing:0.22em;text-transform:uppercase;text-decoration:none;font-family:Arial,sans-serif;">View Your Rewards</a>' +
          '</div>' +

          '<div style="margin-top:36px;padding-top:18px;border-top:1px solid rgba(196,149,106,0.15);font-size:0.7rem;color:rgba(245,240,232,0.4);text-align:center;font-family:Arial,sans-serif;">3960 Highway Z · New Melle, MO 63365 · (636) 224-8257</div>' +
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

function hoursSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / (60 * 60 * 1000);
}

// ─── Main handler ───────────────────────────────────────────────────────────
exports.handler = wrap('toast-order-webhook', async (event) => {
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
  if (already) return reply(200, { ok: true, alreadyCredited: true, orderId });

  // ─── Award visit points ─────────────────────────────────────────────────
  const pointsEarned = pointsFor(total, member, rewards);
  if (pointsEarned <= 0) {
    return reply(200, { ok: true, skipped: 'zero points after multiplier', orderId, total });
  }

  const now = new Date().toISOString();
  const oldTier = member.tier || 'standard';

  member.currentPoints  = (member.currentPoints || 0) + pointsEarned;
  member.lifetimePoints = (member.lifetimePoints || 0) + pointsEarned;
  member.lastVisitAt    = now;
  member.tierWarnedAt   = null; // a real visit resets the tier-decay warning
  member.history.push({
    at: now,
    action: 'earn',
    source: 'toast-webhook',
    orderId,
    delta: pointsEarned,
    spendUsd: total,
    tier: oldTier,
    note: 'Closed tab: $' + total.toFixed(2),
  });

  // ─── Birthday-month bonus (once per calendar year) ──────────────────────
  let birthdayBonus = 0;
  if (member.birthday && /^\d{4}-\d{2}-\d{2}$/.test(member.birthday)) {
    const nowDate = new Date(now);
    const currentMonth = nowDate.getUTCMonth() + 1;
    const currentYear  = nowDate.getUTCFullYear();
    const birthMonth   = parseInt(member.birthday.slice(5, 7), 10);
    if (currentMonth === birthMonth) {
      const alreadyThisYear = member.history.some((h) =>
        h.action === 'earn' && h.source === 'birthday-month' && h.year === currentYear
      );
      if (!alreadyThisYear) {
        birthdayBonus = BIRTHDAY_BONUS;
        member.currentPoints  += birthdayBonus;
        member.lifetimePoints += birthdayBonus;
        member.history.push({
          at: now,
          action: 'earn',
          source: 'birthday-month',
          delta: birthdayBonus,
          year: currentYear,
          note: 'Birthday-month visit bonus',
        });
      }
    }
  }

  // ─── Tier recalc / promotion (promotion-only, based on trailing spend) ──
  const newTier = recalcTier(member, rewards);
  const tierChanged = newTier !== oldTier;
  if (tierChanged) {
    member.tier = newTier;
    member.history.push({
      at: now,
      action: 'tier-promotion',
      from: oldTier,
      to: newTier,
      by: 'auto',
      note: 'Crossed lifetime-points threshold via Toast visit',
    });
  }

  membersFile.json.lastUpdated = now.split('T')[0];

  // ─── Persist ────────────────────────────────────────────────────────────
  try {
    const msgParts = ['toast: +' + pointsEarned + ' pts'];
    if (birthdayBonus) msgParts.push('+' + birthdayBonus + ' bday');
    if (tierChanged)   msgParts.push('→ ' + newTier);
    msgParts.push('(' + (member.email || member.phone || member.id) + ')');
    await saveJson(MEMBERS_PATH, membersFile.json, membersFile.sha, msgParts.join(' '));
  } catch (e) {
    return reply(500, { ok: false, error: 'Save failed: ' + e.message });
  }

  // ─── Emails (fire-and-forget — webhook returns immediately) ─────────────
  // Throttle the visit-confirmation email so lunch + dinner same day don't double-fire
  const lastVisitEmailAt = member.lastVisitEmailAt;
  const sinceLast = hoursSince(lastVisitEmailAt);
  const shouldSendVisitEmail = sinceLast >= VISIT_EMAIL_MIN_GAP_HOURS;
  if (shouldSendVisitEmail) {
    member.lastVisitEmailAt = now;
    // Don't await the save of this field — the next visit will pick it up.
    sendVisitEmail({
      member,
      visitAmount: total,
      basePoints: pointsEarned,
      birthdayBonus,
      newTier,
      oldTier,
      tierChanged,
    }).catch((e) => console.warn('visit email failed:', e && e.message));
  }
  if (tierChanged) {
    sendTierEmail(member.email, member.name, newTier).catch((e) => console.warn('tier email failed:', e && e.message));
  }

  return reply(200, {
    ok: true,
    orderId,
    memberEmail: member.email,
    memberId: member.id,
    pointsEarned,
    birthdayBonus,
    totalPointsThisVisit: pointsEarned + birthdayBonus,
    newBalance: member.currentPoints,
    lifetimePoints: member.lifetimePoints,
    oldTier,
    newTier,
    tierChanged,
    visitEmailSent: shouldSendVisitEmail,
  });
});