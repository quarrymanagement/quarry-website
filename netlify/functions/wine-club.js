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
//   email-all     -> { ok, sent, failed, sendId } body: {subject, html, audience:"active"|"all", attachments:[]}
//   email-test    -> { ok, sendId, messageId }   body: {to, subject?, html?}
//   send-history  -> { sends: [...] }
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
const SEND_LOG_BLOB = 'wine-club-send-log';
const MAX_LOG_ENTRIES = 200;

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

async function readSendLog() {
  const data = await readBlob(SEND_LOG_BLOB);
  if (!data || !Array.isArray(data.sends)) return { sends: [] };
  return data;
}

async function appendSendLog(entry) {
  const log = await readSendLog();
  log.sends.unshift(entry); // newest first
  if (log.sends.length > MAX_LOG_ENTRIES) log.sends.length = MAX_LOG_ENTRIES;
  await writeBlob(SEND_LOG_BLOB, log);
}

// ---------- SendGrid ----------
function sendGridEmail(to, subject, htmlBody, fromEmail, fromName, category, attachments) {
  fromEmail = fromEmail || 'bookings@thequarrystl.com';
  fromName  = fromName  || 'The Quarry STL';
  const toArray = Array.isArray(to) ? to : [to];
  const body = {
    personalizations: [{ to: toArray.map(function(e){ return { email: e }; }) }],
    from: { email: fromEmail, name: fromName },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
    categories: category ? [category] : ['quarry-wine-club'],
    tracking_settings: {
      click_tracking: { enable: true, enable_text: false },
      open_tracking:  { enable: true }
    }
  };
  if (Array.isArray(attachments) && attachments.length) {
    body.attachments = attachments
      .filter(function(a){ return a && a.content && a.filename; })
      .map(function(a) {
        return {
          content:     a.content,
          filename:    a.filename,
          type:        a.type || 'application/octet-stream',
          disposition: 'attachment'
        };
      });
  }
  const payload = JSON.stringify(body);
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
        const messageId = (res.headers && (res.headers['x-message-id'] || res.headers['X-Message-Id'])) || null;
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, messageId: messageId });
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
      const subject     = (body.subject || '').toString().trim();
      const htmlBody    = (body.html    || '').toString();
      const audience    = body.audience || 'active';
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (!subject || !htmlBody) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'subject and html required' }) };
      }
      // base64 inflates raw file size ~1.33x; cap around 7MB to stay under Netlify Functions limits
      const attachBytes = attachments.reduce(function(s, a){ return s + ((a && a.content && a.content.length) || 0); }, 0);
      if (attachBytes > 7 * 1024 * 1024) {
        return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: 'Attachments exceed safe size (~5 MB). Use smaller files.' }) };
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
      const deliveries = []; // per-recipient outcome for the send log
      for (const r of recipients) {
        const rec = { email: r.email, name: r.name || '', status: 'failed', messageId: null, error: null };
        try {
          const personalized = htmlBody
            .replace(/\{firstName\}/g, (r.name || '').split(' ')[0] || '')
            .replace(/\{name\}/g, r.name || '')
            .replace(/\{email\}/g, r.email || '');
          const sgRes = await sendGridEmail(
            r.email,
            subject,
            wrapEmailHtml(subject, personalized, r.email),
            'bookings@thequarrystl.com',
            'The Quarry STL',
            'quarry-wine-club',
            attachments
          );
          rec.status = 'sent';
          rec.messageId = sgRes && sgRes.messageId || null;
          sent++;
        } catch (e) {
          rec.error = e.message;
          failed++;
          errors.push({ email: r.email, error: e.message });
        }
        deliveries.push(rec);
      }
      const entry = {
        id:         'send_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
        sentAt:     nowIso(),
        subject:    subject,
        audience:   audience,
        sent:       sent,
        failed:     failed,
        recipients: recipients.length,
        attachments: attachments.map(function(a){ return { filename: a.filename, size: a.size || (a.content ? a.content.length : 0), type: a.type || '' }; }),
        deliveries: deliveries,
        bodyPreview: htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
      };
      try { await appendSendLog(entry); } catch (e) { console.error('appendSendLog failed:', e.message); }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, sendId: entry.id, sent: sent, failed: failed, audience: audience, recipients: recipients.length, attachments: attachments.length, errors: errors.slice(0, 5) }) };
    }

    if (action === 'send-history') {
      const log = await readSendLog();
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ sends: log.sends }) };
    }

    if (action === 'email-test') {
      // Send to a single specified email address via the same path as email-all.
      // Used for deliverability checks without spamming the full roster.
      if (!process.env.SENDGRID_API_KEY) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SENDGRID_API_KEY not configured' }) };
      }
      const to = (body.to || '').toString().trim().toLowerCase();
      const subject = (body.subject || '').toString().trim() || 'Wine Club test send';
      const htmlIn  = (body.html    || '').toString() || '<p>This is a one-recipient test from the Wine Club admin.</p>';
      if (!to) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'to required' }) };
      try {
        const sgRes = await sendGridEmail(
          to,
          subject,
          wrapEmailHtml(subject, htmlIn, to),
          'bookings@thequarrystl.com',
          'The Quarry STL',
          'quarry-wine-club'
        );
        const entry = {
          id:         'send_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
          sentAt:     nowIso(),
          subject:    subject,
          audience:   'test',
          sent:       1,
          failed:     0,
          recipients: 1,
          attachments: [],
          deliveries: [{ email: to, name: '', status: 'sent', messageId: sgRes && sgRes.messageId || null, error: null }],
          bodyPreview: htmlIn.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
        };
        try { await appendSendLog(entry); } catch (e) { console.error('appendSendLog failed:', e.message); }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, sendId: entry.id, messageId: sgRes && sgRes.messageId || null }) };
      } catch (e) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
      }
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
  } catch (err) {
    console.error('wine-club error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
