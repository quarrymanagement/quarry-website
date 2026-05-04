// ============================================================================
// expire-points.js — annual points expiry cron + 7-day-out warning email
//
// Runs daily via Netlify Scheduled Function. Two jobs:
//
//  1. WARNING (Dec 24-30 only):  emails members with currentPoints > 0 a
//     "your points expire on Dec 31" reminder. One email per member per year.
//
//  2. EXPIRY (Jan 1 only):  resets currentPoints to 0 for every member,
//     adds a `points-expired` history entry, sends a confirmation email
//     with the prior year's lifetime stats. Tier and lifetimePoints are
//     UNCHANGED (only currentPoints resets).
//
// Manual trigger: POST { adminPassword, force?: 'warning'|'expiry' }
//
// ENV: GITHUB_TOKEN, SENDGRID_API_KEY, ADMIN_PASSWORD_HASH (or quarry2026)
// ============================================================================
const crypto = require('crypto');
const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';
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

function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}'), raw: d }); }
        catch (_) { resolve({ status: res.statusCode, data: d, raw: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function gh(method, path, body) {
  return httpsRequest({
    hostname: 'api.github.com', path, method,
    headers: {
      'Authorization': 'token ' + GITHUB_TOKEN,
      'User-Agent': 'Quarry-Expire-Points',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
  }, body);
}

async function loadJson(filePath) {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/' + filePath);
  if (r.status !== 200) throw new Error('GitHub load: HTTP ' + r.status);
  return { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
}

async function saveJson(filePath, json, sha, message) {
  const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64');
  const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/' + filePath, { message, content, sha });
  if (r.status !== 200 && r.status !== 201) throw new Error('GitHub save: HTTP ' + r.status);
  return r.data;
}

function sendEmail(to, subject, html) {
  if (!SENDGRID_KEY) return Promise.resolve(null);
  return httpsRequest({
    hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + SENDGRID_KEY,
      'Content-Type': 'application/json',
    },
  }, {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: 'management@thequarrystl.com', name: 'The Quarry STL' },
    subject,
    content: [{ type: 'text/html', value: html }],
  }).catch(() => null);
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function warningEmail(name, currentPoints) {
  const first = (name || '').split(/\s+/)[0] || 'friend';
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">YEAR-END REMINDER</p></div>' +
    '<div style="padding:32px 24px;background:#FFFFFF">' +
    '<h2 style="color:#2C1A0E;margin-top:0">Hey ' + escHtml(first) + ' —</h2>' +
    '<p style="color:#444;font-size:1rem;line-height:1.6">Just a heads up: your <strong style="color:#B8933A">' + currentPoints.toLocaleString() + ' Quarry points</strong> expire on <strong>December 31 at midnight</strong>.</p>' +
    '<p style="color:#444;font-size:1rem;line-height:1.6">Stop by before then to redeem them on a free bucket of balls, $10 off your bill, a free glass of wine — whatever sounds good. Your tier status sticks around regardless; only the unredeemed points reset.</p>' +
    '<p style="color:#444;font-size:1rem;line-height:1.6">See you at The Quarry.</p>' +
    '<p style="color:#444;font-style:italic;margin-top:24px">— The Quarry Team</p>' +
    '</div></div>';
}

function expiryEmail(name, expiredPts, lifetimePts, tier) {
  const first = (name || '').split(/\s+/)[0] || 'friend';
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">A FRESH YEAR · FRESH POINTS</p></div>' +
    '<div style="padding:32px 24px;background:#FFFFFF">' +
    '<h2 style="color:#2C1A0E;margin-top:0">Happy new year, ' + escHtml(first) + '.</h2>' +
    '<p style="color:#444;font-size:1rem;line-height:1.6">Your point balance has reset for the new year — every member starts fresh.</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px">' +
    '<p style="margin:6px 0;color:#444"><strong>Lifetime points earned:</strong> ' + lifetimePts.toLocaleString() + '</p>' +
    '<p style="margin:6px 0;color:#444"><strong>Status:</strong> ' + escHtml(tier || 'Standard') + ' (your tier stays based on your trailing-90-day spend)</p>' +
    (expiredPts > 0 ? '<p style="margin:6px 0;color:#888;font-style:italic">' + expiredPts.toLocaleString() + ' unredeemed points rolled off.</p>' : '') +
    '</div>' +
    '<p style="color:#444;font-size:1rem;line-height:1.6">Come back anytime — every visit earns at your current tier rate. We\'ll see you soon.</p>' +
    '<p style="color:#444;font-style:italic;margin-top:24px">— The Quarry Team</p>' +
    '</div></div>';
}

async function runWarning() {
  const mFile = await loadJson('members.json');
  const year = String(parseInt((new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric' }).formatToParts(new Date()).find((p) => p.type === 'year') || {}).value, 10));
  const members = mFile.json.members || [];
  let sent = 0;
  for (const m of members) {
    if (!m.email) continue;
    if (!m.marketingOptIn) continue;
    const cur = m.currentPoints || 0;
    if (cur < 100) continue; // skip near-zero balances
    // Skip if we already warned this year
    const alreadyWarned = (m.history || []).some((h) =>
      h.action === 'expiry-warning' && h.note && h.note.indexOf(year) !== -1
    );
    if (alreadyWarned) continue;
    await sendEmail(m.email,
      'Your Quarry points expire Dec 31 — ' + cur.toLocaleString() + ' points',
      warningEmail(m.name, cur));
    m.history = m.history || [];
    m.history.push({
      at: new Date().toISOString(),
      action: 'expiry-warning',
      note: 'Year-end reminder ' + year + ' (had ' + cur + ' pts)',
    });
    sent++;
  }
  if (sent > 0) {
    await saveJson('members.json', mFile.json, mFile.sha,
      'expire-points: warning emails ' + year + ' (' + sent + ' members)');
  }
  return { warningEmailsSent: sent };
}

async function runExpiry() {
  const mFile = await loadJson('members.json');
  const year = String(parseInt((new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric' }).formatToParts(new Date()).find((p) => p.type === 'year') || {}).value, 10));
  const members = mFile.json.members || [];
  let zeroed = 0;
  let totalExpired = 0;
  for (const m of members) {
    const cur = m.currentPoints || 0;
    if (cur <= 0) continue;
    const lifetime = m.lifetimePoints || 0;
    m.currentPoints = 0;
    m.history = m.history || [];
    m.history.push({
      at: new Date().toISOString(),
      action: 'points-expired',
      delta: -cur,
      note: 'Annual reset (year ' + year + '): ' + cur + ' unredeemed points expired. Lifetime + tier preserved.',
    });
    // Send the year-end summary if they're opted in
    if (m.email && m.marketingOptIn) {
      await sendEmail(m.email,
        'Your Quarry points reset for the new year',
        expiryEmail(m.name, cur, lifetime, m.tier ? (m.tier.charAt(0).toUpperCase() + m.tier.slice(1)) : 'Standard'));
    }
    totalExpired += cur;
    zeroed++;
  }
  if (zeroed > 0) {
    await saveJson('members.json', mFile.json, mFile.sha,
      'expire-points: annual reset ' + year + ' (' + zeroed + ' members, ' + totalExpired + ' pts cleared)');
  }
  return { membersZeroed: zeroed, totalPointsExpired: totalExpired };
}

exports.handler = async (event) => {
  const isScheduled = event.headers && event.headers['x-netlify-trigger-source'] === 'scheduled';
  let mode = null;

  if (isScheduled) {
    // Determine the job by today's date in Central Time (Quarry's local calendar)
    const now = new Date();
    const ctParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const get = (t) => parseInt((ctParts.find((x) => x.type === t) || {}).value, 10);
    const m = get('month');
    const d = get('day');
    if (m === 12 && d >= 24 && d <= 30) mode = 'warning';
    else if (m === 1 && d === 1) mode = 'expiry';
    else return reply(200, { ok: true, message: 'Not a warning/expiry day in Central Time; nothing to do.', ctDate: get('year') + '-' + String(m).padStart(2,'0') + '-' + String(d).padStart(2,'0') });
  } else {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }
    if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });
    if (body.force === 'warning' || body.force === 'expiry') mode = body.force;
    else return reply(400, { ok: false, error: "force must be 'warning' or 'expiry'" });
  }

  if (!GITHUB_TOKEN || !SENDGRID_KEY) return reply(500, { ok: false, error: 'Server not configured' });

  try {
    const result = mode === 'warning' ? await runWarning() : await runExpiry();
    return reply(200, { ok: true, mode, ...result, ranAt: new Date().toISOString() });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};

exports.config = {
  // Daily at 07:00 UTC. That's 02:00 CDT (summer) or 01:00 CST (winter) — safely inside the right
  // CT calendar day for the warning/expiry windows.
  schedule: '0 7 * * *',
};
