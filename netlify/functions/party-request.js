// ============================================================================
// party-request.js — receives a private-party reservation inquiry from the
// customer app and (a) saves it to reservations.json, (b) emails Quarry, and
// (c) emails the customer a confirmation.
//
// POST { name, phone, email, date, time, partySize, occasion, seating, notes }
//
// ENV: GITHUB_TOKEN, SENDGRID_API_KEY
// ============================================================================
const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'quarrymanagement/quarry-website';
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

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
      'User-Agent': 'Quarry-Party-Request',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
  }, body);
}

async function loadJson(path) {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/' + path);
  if (r.status === 404) return { sha: null, json: null };
  if (r.status !== 200) throw new Error('GitHub load: HTTP ' + r.status);
  return { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
}

async function saveJson(path, json, sha, message) {
  const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64');
  const body = sha ? { message, content, sha } : { message, content };
  const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/' + path, body);
  if (r.status !== 200 && r.status !== 201) throw new Error('GitHub save: HTTP ' + r.status);
  return r.data;
}

function sendEmail(to, subject, html) {
  return httpsRequest({
    hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + SENDGRID_KEY,
      'Content-Type': 'application/json',
    },
  }, {
    personalizations: [{ to: (Array.isArray(to) ? to : [to]).map((e) => ({ email: e })) }],
    from: { email: 'management@thequarrystl.com', name: 'The Quarry STL' },
    subject,
    content: [{ type: 'text/html', value: html }],
  });
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!GITHUB_TOKEN || !SENDGRID_KEY) return reply(500, { ok: false, error: 'Server not fully configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const { name, phone, email, date, time, partySize, occasion, seating, notes, source } = body;
  if (!name || !email || !phone) {
    return reply(400, { ok: false, error: 'Name, email, and phone are required.' });
  }

  // Save to reservations.json
  const reservationId = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const newEntry = {
    id: reservationId,
    type: 'private-party',
    source: source || 'app',
    submittedAt: new Date().toISOString(),
    status: 'new',
    name, phone, email,
    date: date || '',
    time: time || '',
    partySize: partySize || '',
    occasion: occasion || '',
    seating: seating || '',
    notes: notes || '',
  };

  try {
    const file = await loadJson('reservations.json');
    const data = file.json || { reservations: [] };
    data.reservations = data.reservations || [];
    data.reservations.unshift(newEntry);
    await saveJson('reservations.json', data, file.sha, 'app: party request from ' + name);
  } catch (e) {
    // Don't block on save failure — emails still go out
    console.error('Reservations save failed:', e.message);
  }

  // Build email rows
  const rows = [
    ['Name', name],
    ['Phone', phone],
    ['Email', email],
    ['Date', date],
    ['Start Time', time],
    ['Party Size', partySize],
    ['Occasion', occasion],
    ['Seating Preference', seating],
    ['Notes', notes],
  ].map(([k, v]) => v ? '<p style="margin:6px 0"><strong>' + escHtml(k) + ':</strong> ' + escHtml(v) + '</p>' : '').join('');

  // Email to Quarry team
  try {
    await sendEmail(
      ['management@thequarrystl.com', 'jacqueline@thequarrystl.com'],
      'New Party Request — ' + name + ' (' + (partySize || 'size?') + ')',
      '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
      '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
      '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW PARTY REQUEST · APP</p></div>' +
      '<div style="padding:28px 24px;background:#FFFFFF">' +
      '<h2 style="color:#2C1A0E;margin-top:0">Group of ' + escHtml(String(partySize || '?')) + ' — ' + escHtml(occasion || 'Event') + '</h2>' +
      '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px">' + rows + '</div>' +
      '<p style="color:#444">Reply to this guest at <a href="mailto:' + escHtml(email) + '">' + escHtml(email) + '</a> within 24 hours.</p>' +
      '<p style="color:#888;font-size:0.85em">Reservation ID: ' + reservationId + '</p>' +
      '</div></div>'
    );
  } catch (e) {
    console.error('Owner email failed:', e.message);
  }

  // Confirmation email to the guest
  try {
    await sendEmail(email,
      'Your Party Request at The Quarry',
      '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
      '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
      '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
      '<div style="padding:32px 24px;background:#FFFFFF">' +
      '<h2 style="color:#2C1A0E;margin-top:0">Hi ' + escHtml(name.split(' ')[0]) + ',</h2>' +
      '<p style="color:#444;font-size:1rem;line-height:1.6">Thank you for sending us your party request — we received it and our team will reach out within 24 hours to confirm availability and discuss the details for ' + escHtml(occasion || 'your event') + ' on ' + escHtml(date || 'your selected date') + '.</p>' +
      '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px">' + rows + '</div>' +
      '<p style="color:#444">If you need to update anything before we reach out, just reply to this email.</p>' +
      '<p style="color:#444;font-style:italic;margin-top:24px">— The Quarry Team</p>' +
      '<p style="color:#888;font-size:0.85em;margin-top:32px">Reservation ID: ' + reservationId + '</p>' +
      '</div></div>'
    );
  } catch (e) {
    console.error('Guest confirmation email failed:', e.message);
  }

  return reply(200, {
    ok: true,
    reservationId,
    message: 'Request received. Our team will reach out within 24 hours.',
  });
};
