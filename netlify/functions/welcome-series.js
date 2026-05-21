// ============================================================================
// welcome-series.js — daily cron that sends two onboarding nudges.
//
//   Day-3:  "Haven't been back yet?" — only if the member has NOT visited
//           in person yet (no toast-webhook earn entries since joining).
//   Day-7:  "Here's how the tiers work" — educational, sent regardless of
//           whether they've visited, to reinforce the program structure.
//
// One-per-email guard via member.welcomeSeriesSent = { day3, day7 } so the
// cron is idempotent across daily runs.
//
// Schedule: daily at 15:00 UTC (10am CDT / 9am CST) via netlify.toml.
// Manual trigger: POST { adminPassword, force?: 'day3' | 'day7' }.
//
// ENV: GITHUB_TOKEN, SENDGRID_API_KEY, ADMIN_PASSWORD_HASH (optional)
// ============================================================================
const crypto = require('crypto');
const https  = require('https');
const { wrap } = require('./_sentry');

const GITHUB_TOKEN        = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO         = 'quarrymanagement/quarry-website';
const SENDGRID_KEY        = process.env.SENDGRID_API_KEY || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

const DAY_MS = 24 * 60 * 60 * 1000;

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
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Welcome-Series',
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

function sendgrid(to, subject, html, category) {
  if (!SENDGRID_KEY) return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: 'management@thequarrystl.com', name: 'The Quarry' },
      subject,
      content: [{ type: 'text/html', value: html }],
      categories: [category || 'quarry-welcome-series'],
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

function brandedShell(title, bodyHtml) {
  return (
    '<div style="font-family:Georgia,serif;max-width:520px;margin:40px auto;padding:36px;background:#1A1A1A;color:#F5F0E8;border-radius:8px;">' +
      '<div style="text-align:center;font-size:0.7rem;letter-spacing:0.32em;color:#B8933A;margin-bottom:22px;">THE QUARRY · NEW MELLE · MO</div>' +
      '<h1 style="font-size:1.45rem;text-align:center;color:#F5F0E8;font-weight:600;margin-bottom:18px;">' + title + '</h1>' +
      bodyHtml +
      '<div style="margin-top:36px;padding-top:18px;border-top:1px solid rgba(196,149,106,0.15);font-size:0.7rem;color:rgba(245,240,232,0.4);text-align:center;font-family:Arial,sans-serif;">3960 Highway Z · New Melle, MO 63365 · (636) 224-8257</div>' +
    '</div>'
  );
}

function day3Html(firstName) {
  return brandedShell('We saved you a seat, ' + firstName + '.',
    '<p style="font-size:0.95rem;line-height:1.7;color:rgba(245,240,232,0.85);">It\'s been a few days since you joined Quarry Rewards. We\'d love to see you in.</p>' +
    '<p style="font-size:0.95rem;line-height:1.7;color:rgba(245,240,232,0.85);">A reminder of what\'s waiting:</p>' +
    '<ul style="font-size:0.95rem;line-height:1.7;color:rgba(245,240,232,0.85);padding-left:20px;">' +
      '<li><strong style="color:#D4AF6A;">10 points per $1</strong> at the bar, kitchen, or golf bays</li>' +
      '<li>500 pts = free bucket of balls at Surfside Hole-In-One</li>' +
      '<li>1,000 pts = $10 off your bill</li>' +
    '</ul>' +
    '<div style="text-align:center;margin:32px 0 12px;">' +
      '<a href="https://thequarrystl.com/quarry-reservations.html" style="display:inline-block;padding:14px 32px;border:1px solid #B8933A;color:#D4AF6A;font-size:0.78rem;letter-spacing:0.22em;text-transform:uppercase;text-decoration:none;font-family:Arial,sans-serif;">Book a Reservation</a>' +
    '</div>' +
    '<p style="font-size:0.85rem;line-height:1.7;color:rgba(245,240,232,0.55);font-style:italic;">Or just stop by — we\'re here Wed–Sat, plus Sunday brunch.</p>'
  );
}

function day7Html(firstName) {
  return brandedShell('How tiers work at The Quarry, ' + firstName + '.',
    '<p style="font-size:0.95rem;line-height:1.7;color:rgba(245,240,232,0.85);">Quick primer so you can get the most out of the program:</p>' +
    '<div style="margin:18px 0;">' +
      '<div style="padding:12px 16px;border-left:3px solid rgba(212,175,106,0.35);margin-bottom:10px;background:rgba(245,240,232,0.03);">' +
        '<div style="color:#D4AF6A;font-weight:600;font-family:Georgia,serif;">Quarry Standard · 1.0× earn</div>' +
        '<div style="color:rgba(245,240,232,0.75);font-size:0.9rem;margin-top:4px;">Where everyone starts. Full access to the rewards ladder.</div>' +
      '</div>' +
      '<div style="padding:12px 16px;border-left:3px solid rgba(212,175,106,0.55);margin-bottom:10px;background:rgba(245,240,232,0.03);">' +
        '<div style="color:#D4AF6A;font-weight:600;font-family:Georgia,serif;">Quarry Silver · 1.1× earn</div>' +
        '<div style="color:rgba(245,240,232,0.75);font-size:0.9rem;margin-top:4px;">About $300 of trailing spend. Points come in 10% faster.</div>' +
      '</div>' +
      '<div style="padding:12px 16px;border-left:3px solid #B8933A;margin-bottom:10px;background:rgba(212,175,106,0.08);">' +
        '<div style="color:#D4AF6A;font-weight:600;font-family:Georgia,serif;">Quarry Gold · 1.25× earn + perks</div>' +
        '<div style="color:rgba(245,240,232,0.75);font-size:0.9rem;margin-top:4px;">$600 trailing. 5% off any wine bottle. Free birthday entrée. Early event RSVPs.</div>' +
      '</div>' +
      '<div style="padding:12px 16px;border-left:3px solid #D4AF6A;background:rgba(212,175,106,0.12);">' +
        '<div style="color:#D4AF6A;font-weight:700;font-family:Georgia,serif;">Quarry Elite · 1.5× earn + premium perks</div>' +
        '<div style="color:rgba(245,240,232,0.75);font-size:0.9rem;margin-top:4px;">$1,000 trailing. 10% off bottles. Free glass per visit (when tab > $20). Your name on the wall.</div>' +
      '</div>' +
    '</div>' +
    '<p style="font-size:0.85rem;line-height:1.7;color:rgba(245,240,232,0.6);font-style:italic;">Points themselves never expire — only the tier perks decay if you don\'t visit for 60 days.</p>' +
    '<div style="text-align:center;margin:28px 0 12px;">' +
      '<a href="https://thequarrystl.com/quarry-app-customized.html" style="display:inline-block;padding:14px 32px;border:1px solid #B8933A;color:#D4AF6A;font-size:0.78rem;letter-spacing:0.22em;text-transform:uppercase;text-decoration:none;font-family:Arial,sans-serif;">Open Your Rewards</a>' +
    '</div>'
  );
}

function firstNameOf(m) {
  return ((m.name || m.email || '').split(/[\s@]/)[0]) || 'friend';
}

exports.handler = wrap('welcome-series', async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  let force = null;
  if (event && event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (_) {}
    if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'auth' });
    if (body.force === 'day3' || body.force === 'day7') force = body.force;
  }

  if (!GITHUB_TOKEN) return reply(500, { ok: false, error: 'GITHUB_TOKEN not configured' });

  let mFile;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    mFile = { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
  } catch (e) {
    return reply(500, { ok: false, error: 'Could not load members: ' + e.message });
  }

  const now = Date.now();
  const stats = { day3Sent: 0, day7Sent: 0, skipped: 0, total: 0 };

  for (const m of (mFile.json.members || [])) {
    stats.total++;
    if (!m.email) { stats.skipped++; continue; }

    const joined = m.joinedAt ? new Date(m.joinedAt).getTime() : 0;
    if (!joined) { stats.skipped++; continue; }
    const daysOld = (now - joined) / DAY_MS;

    m.welcomeSeriesSent = m.welcomeSeriesSent || {};
    const hasVisited = (m.history || []).some((h) =>
      h.action === 'earn' && h.source === 'toast-webhook'
    );
    const first = firstNameOf(m);

    // DAY-3: only if no real visits yet
    if ((force === 'day3' || (!force && daysOld >= 3 && daysOld < 7)) && !m.welcomeSeriesSent.day3) {
      if (!hasVisited) {
        await sendgrid(m.email, 'We saved you a seat, ' + first, day3Html(first), 'quarry-welcome-day3');
        m.welcomeSeriesSent.day3 = new Date().toISOString();
        stats.day3Sent++;
      } else {
        // Already visited — mark sent so we don't fire later
        m.welcomeSeriesSent.day3 = 'skipped-already-visited';
      }
      continue;
    }

    // DAY-7: always send, educational
    if ((force === 'day7' || (!force && daysOld >= 7)) && !m.welcomeSeriesSent.day7) {
      await sendgrid(m.email, 'How tiers work at The Quarry', day7Html(first), 'quarry-welcome-day7');
      m.welcomeSeriesSent.day7 = new Date().toISOString();
      stats.day7Sent++;
      continue;
    }

    stats.skipped++;
  }

  if (stats.day3Sent > 0 || stats.day7Sent > 0) {
    mFile.json.lastUpdated = new Date().toISOString().split('T')[0];
    try {
      const content = Buffer.from(JSON.stringify(mFile.json, null, 2), 'utf8').toString('base64');
      const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
        message: 'welcome-series: ' + stats.day3Sent + ' day3, ' + stats.day7Sent + ' day7',
        content, sha: mFile.sha,
      });
      if (r.status !== 200 && r.status !== 201) throw new Error('HTTP ' + r.status);
    } catch (e) {
      return reply(500, { ok: false, error: 'Save failed: ' + e.message, partialStats: stats });
    }
  }

  return reply(200, { ok: true, force, ...stats });
});
