// ============================================================================
// expire-tiers.js — daily cron that enforces the tier-decay rule.
//
// From rewards.json:
//   "If a member has zero spend for 60 days, tier drops one level. A banner
//    appears at day 30 saying 'Visit by [date] to keep your tier.' Points
//    themselves never expire — only the tier perks decay."
//
// Two passes:
//   1. WARNING — at exactly 30 days since lastVisitAt, send a "Visit by
//      [date] to keep your tier" email. One warning per decay-cycle (we
//      record warnedAt on the member to dedupe).
//   2. DOWNGRADE — at 60+ days since lastVisitAt, drop one tier level
//      (elite → gold → silver → standard, standard stays put). Records the
//      downgrade in member.history. lifetimePoints + currentPoints are
//      UNCHANGED — only the tier label changes.
//
// Schedule: daily at 13:00 UTC (8am CDT / 7am CST) via netlify.toml.
// Manual trigger: POST { adminPassword, force?: 'warning' | 'downgrade' }.
//
// ENV: GITHUB_TOKEN, SENDGRID_API_KEY, ADMIN_PASSWORD_HASH (optional)
// ============================================================================
const crypto = require('crypto');
const https  = require('https');

const GITHUB_TOKEN        = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO         = 'quarrymanagement/quarry-website';
const SENDGRID_KEY        = process.env.SENDGRID_API_KEY || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

const WARNING_DAYS   = 30;
const DOWNGRADE_DAYS = 60;
const TIER_ORDER     = ['standard', 'silver', 'gold', 'elite'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
        'User-Agent': 'Quarry-Tier-Decay',
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

function sendgrid(to, subject, html) {
  if (!SENDGRID_KEY) return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: 'management@thequarrystl.com', name: 'The Quarry STL' },
      subject,
      content: [{ type: 'text/html', value: html }],
      categories: ['quarry-tier-decay'],
    });
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

function daysSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

function buildWarningHtml(name, currentTier, daysLeft) {
  const tierLabel = currentTier.charAt(0).toUpperCase() + currentTier.slice(1);
  return (
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">REWARDS</p></div>' +
    '<div style="padding:32px 24px;background:#fff">' +
    '<h2 style="color:#2C1A0E;margin-top:0">Visit us by month-end to keep your ' + tierLabel + ' status.</h2>' +
    '<p style="color:#444;line-height:1.6">Hi ' + (name || 'friend') + ', it\'s been a while! Your Quarry ' + tierLabel + ' tier comes with perks ' +
    '(better earn rate, bottle discounts, birthday entrée at Gold+). Those perks drop one level if you don\'t come ' +
    'in within the next <strong>' + daysLeft + ' days</strong>.</p>' +
    '<p style="color:#444;line-height:1.6">Your points themselves don\'t expire — only the tier benefits decay.</p>' +
    '<p style="color:#444;line-height:1.6">We\'d love to see you soon. <a href="https://thequarrystl.com/quarry-reservations" style="color:#B8933A;font-weight:600">Book a table</a> or just stop in.</p>' +
    '</div></div>'
  );
}

function buildDowngradeHtml(name, oldTier, newTier) {
  const niceOld = oldTier.charAt(0).toUpperCase() + oldTier.slice(1);
  const niceNew = newTier.charAt(0).toUpperCase() + newTier.slice(1);
  return (
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">REWARDS</p></div>' +
    '<div style="padding:32px 24px;background:#fff">' +
    '<h2 style="color:#2C1A0E;margin-top:0">Your tier has shifted from ' + niceOld + ' to ' + niceNew + '.</h2>' +
    '<p style="color:#444;line-height:1.6">Hi ' + (name || 'friend') + ', because it\'s been 60+ days since your last visit, we\'ve dropped your tier one level per the rewards program rules.</p>' +
    '<p style="color:#444;line-height:1.6"><strong>Your points are intact</strong> — only the tier-specific perks (bottle discounts, earn multiplier, etc.) have changed.</p>' +
    '<p style="color:#444;line-height:1.6">Come back any time — your trailing spend rebuilds quickly. We\'d love to see you. <a href="https://thequarrystl.com/quarry-reservations" style="color:#B8933A;font-weight:600">Book a table</a>.</p>' +
    '</div></div>'
  );
}

exports.handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // Allow manual trigger via admin password; otherwise only run as scheduled cron
  let manual = false;
  if (event && event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (_) {}
    if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'auth' });
    manual = true;
  }

  if (!GITHUB_TOKEN) return reply(500, { ok: false, error: 'GITHUB_TOKEN not configured' });

  // Load members.json
  let mFile;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    mFile = { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
  } catch (e) {
    return reply(500, { ok: false, error: 'Could not load members: ' + e.message });
  }

  const stats = { warned: 0, downgraded: 0, skipped: 0, total: 0 };
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const m of (mFile.json.members || [])) {
    stats.total++;
    const tier = (m.tier || 'standard').toLowerCase();
    const tierIdx = TIER_ORDER.indexOf(tier);
    if (tierIdx <= 0) { stats.skipped++; continue; } // standard tier has nothing to lose

    const dsv = daysSince(m.lastVisitAt);

    // WARNING phase
    if (dsv >= WARNING_DAYS && dsv < DOWNGRADE_DAYS) {
      // Only warn once per decay cycle. We record last-warn date; if it's
      // newer than lastVisitAt the warning has already gone out for this lull.
      const warnedAt = m.tierWarnedAt || '';
      const recentlyWarned = warnedAt && new Date(warnedAt).getTime() > new Date(m.lastVisitAt || 0).getTime();
      if (!recentlyWarned && m.email) {
        await sendgrid(m.email, 'Visit by month-end to keep your Quarry ' + (tier.charAt(0).toUpperCase() + tier.slice(1)) + ' status', buildWarningHtml(m.name, tier, DOWNGRADE_DAYS - dsv));
        m.tierWarnedAt = new Date().toISOString();
        stats.warned++;
      } else {
        stats.skipped++;
      }
      continue;
    }

    // DOWNGRADE phase
    if (dsv >= DOWNGRADE_DAYS) {
      const newTier = TIER_ORDER[tierIdx - 1];
      m.tier = newTier;
      m.history = m.history || [];
      m.history.push({
        at: new Date().toISOString(),
        action: 'tier-downgrade',
        from: tier,
        to: newTier,
        daysInactive: dsv,
        by: 'auto',
        note: 'Tier decay: 60+ days since last visit',
      });
      // Reset the warning marker so the next cycle can warn again
      m.tierWarnedAt = null;
      if (m.email) {
        await sendgrid(m.email, 'Your Quarry tier moved to ' + (newTier.charAt(0).toUpperCase() + newTier.slice(1)), buildDowngradeHtml(m.name, tier, newTier));
      }
      stats.downgraded++;
      continue;
    }

    stats.skipped++;
  }

  // Only write if something changed
  if (stats.warned > 0 || stats.downgraded > 0) {
    mFile.json.lastUpdated = todayIso;
    try {
      const content = Buffer.from(JSON.stringify(mFile.json, null, 2), 'utf8').toString('base64');
      const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
        message: 'tier-decay: ' + stats.warned + ' warned, ' + stats.downgraded + ' downgraded',
        content, sha: mFile.sha,
      });
      if (r.status !== 200 && r.status !== 201) throw new Error('HTTP ' + r.status);
    } catch (e) {
      return reply(500, { ok: false, error: 'Save failed: ' + e.message, partialStats: stats });
    }
  }

  return reply(200, { ok: true, manual, runAt: todayIso, ...stats });
};
