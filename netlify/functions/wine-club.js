// ============================================================================
// wine-club.js
//
// Admin API for the Rock & Vine Wine Club member roster.
//
// Backed by the existing Netlify Blob key `wine-club-members`. The same blob
// is also written by square-webhook.js when new Square subscriptions are
// created/updated; this function exposes CRUD + bulk import + bulk email so
// the admin tab can manage the full list in one place.
//
// Actions (POST body {action: "..."}):
//   list          -> { members: [...] }
//   add           -> { ok, member }              body: {member:{...}}
//   update        -> { ok, member }              body: {id, patch:{...}}
//   delete        -> { ok }                      body: {id}
//   import        -> { ok, added, updated }      body: {members:[...], mode:"merge"|"replace"}
//   email-all     -> { ok, sent, failed }        body: {subject, html, audience:"active"|"all"}
//
// Member shape:
//   { id, name, email, phone, plan, price, joinedAt, status, source,
//     notes, subscriptionId, customerId, lastEventAt, lastEventType }
// ============================================================================

const https = require('https');
const crypto = require('crypto');
const { readBlob, writeBlob } = require('./_blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const BLOB_KEY = 'wine-club-members';

// ---------- Blob storage ----------
async function readRoster() {
  const data = await readBlob(BLOB_KEY);
  if (!data || !Array.isArray(data.members)) return { members: [] };
  return data;
}

async function writeRoster(roster) {
  const ok = await writeBlob(BLOB_KEY, roster);
  if (!ok) throw new Error('Blob write failed (see function logs)');
}

// ---------- SendGrid ----------
function sendGridEmail(to, subject, htmlBody, fromEmail, fromName, category) {
  fromEmail = fromEmail || 'bookings@thequarrystl.com';
  fromName  = fromName  || 'The Quarry STL';
  const toArray = Array.isArray(to) ? to : [to];
  const payload = JSON.stringify({
    personalizations: [{ to: toArray.map(function(e){ return { email: e }; }) }],
    from: { email: fromEmail, name: fromName },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
    categories: category ? [category] : ['quarry-wine-club'],
    tracking_settings: {
      click_tracking: { enable: true, enable_text: false },
      open_tracking:  { enable: true }
    }
  });
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.SENDGRID_API_KEY,
        'Content-Type': 'application/json'
      }
    }, function(res) {
      let body = '';
      res.on('data', function(c){ body += c; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode });
        else reject(new Error('SendGrid ' + res.statusCode + ': ' + body));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------- Helpers ----------
function newId() {
  return 'wc_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}
function normEmail(e) { return (e || '').toString().trim().toLowerCase(); }
function nowIso()     { return new Date().toISOString(); }

function sanitizeMember(m) {
  m = m || {};
  return {
    id:             m.id || newId(),
    name:           (m.name || '').toString().trim(),
    email:          normEmail(m.email),
    phone:          (m.phone || '').toString().trim(),
    plan:           (m.plan || 'Rock & Vine Wine Club').toString().trim(),
    price:          (m.price || '').toString().trim(),
    joinedAt:       (m.joinedAt || m.startDate || '').toString().trim(),
    status:         (m.status || 'Active').toString().trim(),
    source:         (m.source || 'Manual').toString().trim(),
    notes:          (m.notes || '').toString(),
    subscriptionId: (m.subscriptionId || '').toString(),
    customerId:     (m.customerId || '').toString(),
    lastEventAt:    m.lastEventAt || nowIso(),
    lastEventType:  m.lastEventType || (m.id ? 'updated' : 'created')
  };
}

function findIndex(members, id) {
  return members.findIndex(function(m){ return m.id === id; });
}

function findByEmailOrSub(members, email, subscriptionId) {
  const e = normEmail(email);
  return members.findIndex(function(m) {
    if (subscriptionId && m.subscriptionId && m.subscriptionId === subscriptionId) return true;
    if (e && normEmail(m.email) === e) return true;
    return false;
  });
}

// ---------- Email shell ----------
function wrapEmailHtml(subject, innerHtml, recipientEmail) {
  const unsub = 'https://thequarrystl.com/.netlify/functions/unsubscribe?email=' + encodeURIComponent(recipientEmail || '') + '&list=wine-club';
  return ''
    + '<div style="font-family:Georgia,serif;max-width:640px;margin:0 auto;background:#FAF7F2;color:#2C1A0E">'
    + '  <div style="background:#1A0E08;padding:28px;text-align:center">'
    + '    <h1 style="color:#B8933A;margin:0;font-size:26px;letter-spacing:0.05em">THE QUARRY</h1>'
    + '    <p style="color:#F5F0E8;font-size:11px;letter-spacing:0.2em;margin:6px 0 0">ROCK &amp; VINE WINE CLUB</p>'
    + '  </div>'
    + '  <div style="padding:32px 28px;font-size:16px;line-height:1.55">'
    +      innerHtml
    + '  </div>'
    + '  <div style="background:#1A0E08;color:#C9B98A;padding:20px 24px;text-align:center;font-size:12px;line-height:1.5;font-family:Arial,sans-serif">'
    + '    <p style="margin:0 0 6px 0">The Quarry &middot; 3960 Highway Z, New Melle, MO 63385</p>'
    + '    <p style="margin:0"><a href="' + unsub + '" style="color:#C9B98A;text-decoration:underline">Unsubscribe from Wine Club emails</a></p>'
    + '  </div>'
    + '</div>';
}

// ---------- Handler ----------
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // Allow GET for ?action=list convenience
  let action, body = {};
  if (event.httpMethod === 'GET') {
    action = (event.queryStringParameters || {}).action || 'list';
  } else if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
    action = body.action || 'list';
  } else {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    if (action === 'list') {
      const roster = await readRoster();
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ members: roster.members || [] }) };
    }

    if (action === 'add') {
      const roster = await readRoster();
      const m = sanitizeMember(body.member || {});
      if (!m.email && !m.name) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Name or email required' }) };
      }
      // Dedupe by email
      const dupeIdx = findByEmailOrSub(roster.members, m.email, m.subscriptionId);
      if (dupeIdx >= 0) {
        roster.members[dupeIdx] = Object.assign({}, roster.members[dupeIdx], m, { id: roster.members[dupeIdx].id });
      } else {
        roster.members.push(m);
      }
      await writeRoster({ members: roster.members });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, member: m }) };
    }

    if (action === 'update') {
      const roster = await readRoster();
      const id = body.id;
      const idx = findIndex(roster.members, id);
      if (idx < 0) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found' }) };
      const merged = sanitizeMember(Object.assign({}, roster.members[idx], body.patch || {}, { id: id, lastEventAt: nowIso(), lastEventType: 'updated' }));
      roster.members[idx] = merged;
      await writeRoster({ members: roster.members });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, member: merged }) };
    }

    if (action === 'delete') {
      const roster = await readRoster();
      const id = body.id;
      const before = roster.members.length;
      roster.members = roster.members.filter(function(m){ return m.id !== id; });
      await writeRoster({ members: roster.members });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, removed: before - roster.members.length }) };
    }

    if (action === 'import') {
      const incoming = Array.isArray(body.members) ? body.members : [];
      const mode     = body.mode === 'replace' ? 'replace' : 'merge';
      const roster   = mode === 'replace' ? { members: [] } : await readRoster();
      let added = 0, updated = 0;
      for (const raw of incoming) {
        const m = sanitizeMember(raw);
        if (!m.email && !m.name) continue;
        const idx = findByEmailOrSub(roster.members, m.email, m.subscriptionId);
        if (idx >= 0) {
          roster.members[idx] = Object.assign({}, roster.members[idx], m, { id: roster.members[idx].id });
          updated++;
        } else {
          roster.members.push(m);
          added++;
        }
      }
      await writeRoster({ members: roster.members });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, added: added, updated: updated, total: roster.members.length }) };
    }

    if (action === 'email-all') {
      if (!process.env.SENDGRID_API_KEY) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SENDGRID_API_KEY not configured' }) };
      }
      const subject  = (body.subject || '').toString().trim();
      const htmlBody = (body.html    || '').toString();
      const audience = body.audience || 'active';
      if (!subject || !htmlBody) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'subject and html required' }) };
      }
      const roster = await readRoster();
      const recipients = (roster.members || []).filter(function(m) {
        if (!m.email) return false;
        if (audience === 'all') return true;
        if (audience === 'active-paused') return /^(active|paused)$/i.test(m.status || '');
        return /^active$/i.test(m.status || '');
      });

      let sent = 0, failed = 0;
      const errors = [];
      // Send individually so each recipient gets their own unsubscribe link
      for (const r of recipients) {
        try {
          const personalized = htmlBody
            .replace(/\{firstName\}/g, (r.name || '').split(' ')[0] || '')
            .replace(/\{name\}/g, r.name || '')
            .replace(/\{email\}/g, r.email || '');
          await sendGridEmail(
            r.email,
            subject,
            wrapEmailHtml(subject, personalized, r.email),
            'bookings@thequarrystl.com',
            'The Quarry STL',
            'quarry-wine-club'
          );
          sent++;
        } catch (e) {
          failed++;
          errors.push({ email: r.email, error: e.message });
        }
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, sent: sent, failed: failed, audience: audience, recipients: recipients.length, errors: errors.slice(0, 5) }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
  } catch (err) {
    console.error('wine-club error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
