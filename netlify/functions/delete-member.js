// ============================================================================
// delete-member.js — honor the 30-day account-deletion promise from
// /privacy.html. Two callers:
//
//   1. SELF-DELETE (member-authed)
//      POST { token, confirm: 'DELETE MY ACCOUNT' }
//
//      Member is signed in (session token) and explicitly types the confirm
//      phrase. We hard-delete their record, also remove their email from the
//      SendGrid Subscribed list, and email a "your account has been deleted"
//      confirmation.
//
//   2. ADMIN-DELETE (admin-authed)
//      POST { adminPassword, memberEmail, confirm: 'DELETE MY ACCOUNT', reason? }
//
//      For when a customer emails management@thequarrystl.com asking for
//      deletion (CCPA / GDPR-style request).
//
// The deletion is HARD — the member record is removed and the entire points
// history goes with it. (We do not anonymize-and-retain because that's a worse
// privacy posture than just deleting outright.)
//
// ENV: MEMBER_AUTH_SECRET, GITHUB_TOKEN, ADMIN_PASSWORD_HASH (optional),
//      SENDGRID_API_KEY, SENDGRID_LIST_SUBSCRIBED (optional — for unsubscribe)
// ============================================================================
const crypto = require('crypto');
const https  = require('https');
const { wrap } = require('./_sentry');

const SECRET                  = process.env.MEMBER_AUTH_SECRET || '';
const GITHUB_TOKEN            = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO             = 'quarrymanagement/quarry-website';
const ADMIN_PASSWORD_HASH     = process.env.ADMIN_PASSWORD_HASH || '';
const SENDGRID_KEY            = process.env.SENDGRID_API_KEY || '';
const SENDGRID_LIST_SUBSCRIBED = process.env.SENDGRID_LIST_SUBSCRIBED || '';
const SESSION_TTL_DAYS        = 30;
const CONFIRM_PHRASE          = 'DELETE MY ACCOUNT';

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

function verifySessionToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const [email, issuedStr, sig] = parts;
    const expected = crypto.createHmac('sha256', SECRET).update(email + ':' + issuedStr).digest('hex');
    if (sig !== expected) return null;
    const ageMs = Date.now() - parseInt(issuedStr, 10);
    if (ageMs > SESSION_TTL_DAYS * 24 * 3600 * 1000) return null;
    return { email };
  } catch (_) { return null; }
}

function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'Quarry-Delete-Member',
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

// Remove from SendGrid Subscribed list — best effort, never blocks deletion
async function sgRemoveContact(email) {
  if (!SENDGRID_KEY || !email) return;
  try {
    await new Promise((resolve) => {
      const path = '/v3/marketing/contacts?emails=' + encodeURIComponent(email);
      const req = https.request({
        hostname: 'api.sendgrid.com', path, method: 'GET',
        headers: { 'Authorization': 'Bearer ' + SENDGRID_KEY },
      }, (res) => {
        let d = '';
        res.on('data', (c) => d += c);
        res.on('end', () => {
          try {
            const o = JSON.parse(d || '{}');
            const contactIds = o.result && Object.keys(o.result || {});
            if (contactIds && contactIds.length) {
              const delReq = https.request({
                hostname: 'api.sendgrid.com',
                path: '/v3/marketing/contacts?ids=' + encodeURIComponent(contactIds.join(',')),
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + SENDGRID_KEY },
              }, (r2) => { r2.on('data', () => {}); r2.on('end', resolve); });
              delReq.on('error', resolve);
              delReq.end();
            } else { resolve(); }
          } catch (_) { resolve(); }
        });
      });
      req.on('error', resolve);
      req.end();
    });
  } catch (_) { /* swallow */ }
}

async function sendDeletionConfirmation(email, name) {
  if (!SENDGRID_KEY || !email) return;
  const firstName = (name || email).split(/[\s@]/)[0] || 'Friend';
  const body = JSON.stringify({
    personalizations: [{ to: [{ email }] }],
    from: { email: 'management@thequarrystl.com', name: 'The Quarry' },
    subject: 'Your Quarry account has been deleted',
    categories: ['quarry-account-deleted'],
    content: [{
      type: 'text/html',
      value:
        '<div style="font-family:Georgia,serif;max-width:520px;margin:40px auto;padding:36px;background:#1A1A1A;color:#F5F0E8;border-radius:8px;">' +
          '<div style="text-align:center;font-size:0.7rem;letter-spacing:0.32em;color:#B8933A;margin-bottom:22px;">THE QUARRY · NEW MELLE · MO</div>' +
          '<h1 style="font-size:1.4rem;text-align:center;color:#F5F0E8;font-weight:600;margin-bottom:14px;">Your account has been deleted, ' + firstName + '.</h1>' +
          '<p style="font-size:0.95rem;color:rgba(245,240,232,0.85);line-height:1.7;">As requested, your Quarry Rewards account and all associated data — your points balance, visit history, and contact details — have been permanently removed. You will not receive any more rewards emails or notifications from us.</p>' +
          '<p style="font-size:0.95rem;color:rgba(245,240,232,0.85);line-height:1.7;">If this was a mistake, you are welcome to sign up again any time at <a href="https://thequarrystl.com/quarry-app-customized.html" style="color:#D4AF6A;">thequarrystl.com</a>. A new account will start fresh — prior points cannot be restored.</p>' +
          '<p style="font-size:0.95rem;color:rgba(245,240,232,0.85);line-height:1.7;margin-top:24px;">Thanks for being a Quarry guest.</p>' +
          '<div style="margin-top:36px;padding-top:18px;border-top:1px solid rgba(196,149,106,0.15);font-size:0.7rem;color:rgba(245,240,232,0.4);text-align:center;">3960 Highway Z · New Melle, MO 63365 · (636) 224-8257</div>' +
        '</div>',
    }],
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SENDGRID_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

exports.handler = wrap('delete-member', async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!SECRET || !GITHUB_TOKEN) return reply(500, { ok: false, error: 'Server not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (body.confirm !== CONFIRM_PHRASE) {
    return reply(400, { ok: false, error: 'Confirmation phrase missing. Send confirm: "' + CONFIRM_PHRASE + '".' });
  }

  // Resolve the target email — either from the session token (self-delete)
  // or from the admin-supplied memberEmail (admin-delete)
  let targetEmail = null;
  let isAdmin = false;
  if (body.token) {
    const session = verifySessionToken(body.token);
    if (!session) return reply(401, { ok: false, error: 'Not signed in or session expired' });
    targetEmail = session.email.toLowerCase();
  } else if (body.adminPassword) {
    if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });
    targetEmail = String(body.memberEmail || '').toLowerCase().trim();
    if (!targetEmail) return reply(400, { ok: false, error: 'memberEmail required for admin delete' });
    isAdmin = true;
  } else {
    return reply(400, { ok: false, error: 'Provide either token (self-delete) or adminPassword + memberEmail (admin-delete).' });
  }

  // Load + delete
  let mFile;
  try {
    const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/members.json');
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    mFile = { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
  } catch (e) {
    return reply(500, { ok: false, error: 'Could not load members.json: ' + e.message });
  }

  const before = (mFile.json.members || []).length;
  const member = (mFile.json.members || []).find((x) => (x.email || '').toLowerCase() === targetEmail);
  if (!member) return reply(404, { ok: false, error: 'No member found for ' + targetEmail });

  const memberName = member.name || '';
  mFile.json.members = (mFile.json.members || []).filter((x) => (x.email || '').toLowerCase() !== targetEmail);
  mFile.json.lastUpdated = new Date().toISOString().split('T')[0];
  const after = mFile.json.members.length;

  try {
    const content = Buffer.from(JSON.stringify(mFile.json, null, 2), 'utf8').toString('base64');
    const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/members.json', {
      message: 'account-deletion: ' + targetEmail + (isAdmin ? ' (admin' + (body.reason ? ': ' + String(body.reason).slice(0, 50) : '') + ')' : ' (self)'),
      content, sha: mFile.sha,
    });
    if (r.status !== 200 && r.status !== 201) throw new Error('HTTP ' + r.status);
  } catch (e) {
    return reply(500, { ok: false, error: 'Save failed: ' + e.message });
  }

  // Fire-and-forget: remove from SendGrid + send confirmation
  sgRemoveContact(targetEmail).catch(() => {});
  sendDeletionConfirmation(targetEmail, memberName).catch(() => {});

  return reply(200, {
    ok: true,
    deleted: targetEmail,
    isAdmin,
    membersBefore: before,
    membersAfter: after,
  });
});
