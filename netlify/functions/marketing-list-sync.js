// ============================================================================
// marketing-list-sync.js  (scheduled — see netlify.toml)
//
// Safety net that keeps the SendGrid marketing list complete, so nobody who
// gave us an email address slips through if a form, webhook or checkout sync
// ever breaks. Per the privacy policy, anyone who provides an email (except
// job applicants) goes on the list. Anyone on SendGrid's global unsubscribe
// list (unsubscribe link, deleted accounts) is skipped and never re-added.
//
// Sources collected every run:
//   1. subscribers.json (CRM, fed by every Netlify form)  — careers-only and
//      'Unsubscribed' entries are skipped
//   2. events.json registrations (every event ticket buyer)
//   3. golf-bookings/* blobs (golf bay bookings)
//   4. quarryfest-vendors/* blobs (Quarry Fest vendors)
//
// Everything is upserted in one PUT /v3/marketing/contacts call with
// list_ids [SENDGRID_LIST_ALL, SENDGRID_LIST_SUBSCRIBED]. The call is
// idempotent: existing contacts keep their data and just gain the list.
//
// If the sync fails, an alert email goes to management@thequarrystl.com so a
// broken sync is noticed the same day instead of months later.
// ============================================================================

const fetch = require('node-fetch');
const { readBlob, writeBlob, listKeys } = require('./_blobs');

const SITE_URL = process.env.URL || 'https://thequarrystl.com';
const ALERT_TO = 'management@thequarrystl.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function norm(e) { return String(e || '').trim().toLowerCase(); }

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

async function getJson(url) {
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json();
}

async function collectContacts(errors) {
  const map = new Map();
  const add = (email, first, last, source) => {
    const e = norm(email);
    if (!EMAIL_RE.test(e)) return;
    const prev = map.get(e);
    if (prev) { if (!prev.first && first) prev.first = first; if (!prev.last && last) prev.last = last; return; }
    map.set(e, { email: e, first: first || '', last: last || '', source });
  };

  // 1) CRM (subscribers.json via data-store)
  try {
    const d = await getJson(SITE_URL + '/.netlify/functions/data-store?file=subscribers.json');
    const list = Array.isArray(d.decoded) ? d.decoded : [];
    for (const s of list) {
      if (String(s.emailStatus || '').toLowerCase() === 'unsubscribed') continue;
      const types = (Array.isArray(s.events) ? s.events : []).map((ev) => ev && ev.type).filter(Boolean);
      const sources = types.concat(s.source ? [s.source] : []);
      if (sources.length && sources.every((t) => t === 'careers')) continue; // job applicants only
      add(s.email, s.firstName, s.lastName, 'crm');
    }
  } catch (e) { errors.push('subscribers.json: ' + e.message); }

  // 2) Event ticket buyers (GitHub copy is always current; site copy can lag)
  try {
    let data;
    try { data = await getJson('https://raw.githubusercontent.com/quarrymanagement/quarry-website/main/events.json'); }
    catch (_) { data = await getJson(SITE_URL + '/events.json'); }
    const events = Array.isArray(data) ? data : (data.events || []);
    for (const ev of events) {
      for (const r of (ev.registrations || [])) {
        const n = splitName(r.name || r.customerName);
        add(r.email || r.customerEmail, n.first, n.last, 'event');
      }
    }
  } catch (e) { errors.push('events.json: ' + e.message); }

  // 3) Golf bookings + 4) Quarry Fest vendors (Netlify Blobs)
  for (const store of ['golf-bookings', 'quarryfest-vendors']) {
    try {
      const keys = await listKeys(store);
      for (let i = 0; i < keys.length; i += 10) {
        const batch = await Promise.all(keys.slice(i, i + 10).map((k) => readBlob(store + '/' + k)));
        for (const b of batch) {
          if (!b) continue;
          for (const row of (b.bookings || b.vendors || [])) {
            if (store === 'quarryfest-vendors' && row.status !== 'booked') continue;
            const n = splitName(row.customerName || row.contactName);
            add(row.customerEmail || row.email, n.first, n.last, store);
          }
        }
      }
    } catch (e) { errors.push(store + ': ' + e.message); }
  }

  return [...map.values()];
}

// Everyone SendGrid has globally unsubscribed (unsubscribe link, deleted
// accounts). They are never re-added to the list.
async function getGlobalUnsubscribes(key) {
  const out = new Set();
  for (let offset = 0; offset < 50000; offset += 500) {
    const r = await fetch('https://api.sendgrid.com/v3/suppression/unsubscribes?limit=500&offset=' + offset, {
      headers: { Authorization: 'Bearer ' + key }, timeout: 8000
    });
    if (!r.ok) throw new Error('SendGrid unsubscribes ' + r.status);
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    rows.forEach((x) => x && x.email && out.add(norm(x.email)));
    if (rows.length < 500) break;
  }
  return out;
}

async function upsertToSendGrid(contacts, key, listIds) {
  const jobs = [];
  for (let i = 0; i < contacts.length; i += 5000) {
    const chunk = contacts.slice(i, i + 5000).map((c) => {
      const o = { email: c.email };
      if (c.first) o.first_name = c.first;
      if (c.last) o.last_name = c.last;
      return o;
    });
    const r = await fetch('https://api.sendgrid.com/v3/marketing/contacts', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_ids: listIds, contacts: chunk }),
      timeout: 15000
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('SendGrid PUT ' + r.status + ': ' + JSON.stringify(body).slice(0, 300));
    jobs.push(body.job_id);
  }
  return jobs;
}

async function sendAlert(key, subject, text) {
  try {
    await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: ALERT_TO }] }],
        from: { email: ALERT_TO, name: 'Quarry Website' },
        subject,
        content: [{ type: 'text/plain', value: text }]
      }),
      timeout: 8000
    });
  } catch (e) { console.error('alert email failed:', e.message); }
}

exports.handler = async () => {
  const key = process.env.SENDGRID_API_KEY;
  const listIds = [process.env.SENDGRID_LIST_ALL, process.env.SENDGRID_LIST_SUBSCRIBED].filter(Boolean);
  const errors = [];
  if (!key || !process.env.SENDGRID_LIST_SUBSCRIBED) {
    console.error('marketing-list-sync: SENDGRID_API_KEY or SENDGRID_LIST_SUBSCRIBED missing');
    return { statusCode: 500, body: 'missing env' };
  }

  let contacts = [];
  let jobs = [];
  try {
    contacts = await collectContacts(errors);
    const unsubscribed = await getGlobalUnsubscribes(key);
    contacts = contacts.filter((c) => !unsubscribed.has(c.email));
    if (contacts.length) jobs = await upsertToSendGrid(contacts, key, listIds);
  } catch (e) {
    errors.push(e.message);
  }

  // Track which emails were new since the last run (for the log / alert).
  const prev = (await readBlob('marketing-sync/state')) || {};
  const prevSet = new Set(prev.emails || []);
  const fresh = contacts.filter((c) => !prevSet.has(c.email)).length;
  if (!errors.length || contacts.length) {
    await writeBlob('marketing-sync/state', {
      lastRun: new Date().toISOString(),
      total: contacts.length,
      newSinceLastRun: fresh,
      jobs,
      errors,
      emails: contacts.map((c) => c.email)
    });
  }

  console.log('marketing-list-sync:', JSON.stringify({ total: contacts.length, newSinceLastRun: fresh, jobs, errors }));

  if (errors.length) {
    await sendAlert(key, 'Action needed: email list sync had a problem',
      'The automatic sync that keeps your SendGrid marketing list up to date ran into a problem.\n\n' +
      errors.map((e) => '- ' + e).join('\n') +
      '\n\nContacts collected this run: ' + contacts.length +
      '\nNothing has been lost: the next run (every 6 hours) will retry automatically.');
  }

  return { statusCode: 200, body: JSON.stringify({ total: contacts.length, newSinceLastRun: fresh, errors }) };
};
