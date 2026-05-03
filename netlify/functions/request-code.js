// ============================================================================
// request-code.js — passwordless email code request
//
// POST { email } → sends a 6-digit code via SendGrid, returns ok.
// The code is deterministic (HMAC of email + minute) so we don't need storage —
// verify-code.js regenerates and compares against the last 10 minutes.
//
// ENV: MEMBER_AUTH_SECRET, SENDGRID_API_KEY
// ============================================================================
const crypto = require('crypto');
const https = require('https');

const SECRET = process.env.MEMBER_AUTH_SECRET || '';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const FROM_EMAIL = 'management@thequarrystl.com';
const FROM_NAME  = 'The Quarry';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function codeForMinute(email, min) {
  const h = crypto.createHmac('sha256', SECRET)
    .update(`${email.toLowerCase().trim()}:${min}`)
    .digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}

async function sendEmail(to, code) {
  const body = JSON.stringify({
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Your Quarry sign-in code',
    content: [{
      type: 'text/html',
      value:
        '<div style="font-family:Georgia,\'Playfair Display\',serif;max-width:480px;margin:40px auto;padding:32px;background:#1A1A1A;color:#F5F0E8;text-align:center;border-radius:8px;">' +
          '<div style="font-size:0.7rem;letter-spacing:0.32em;color:#B8933A;margin-bottom:18px;">THE QUARRY · NEW MELLE · MO</div>' +
          '<h1 style="font-size:1.4rem;font-weight:600;margin-bottom:12px;color:#F5F0E8;">Your sign-in code</h1>' +
          '<div style="font-size:2.6rem;letter-spacing:0.16em;font-weight:600;color:#D4AF6A;margin:24px 0;padding:18px;background:rgba(184,147,58,0.1);border:1px solid rgba(196,149,106,0.25);">' + code + '</div>' +
          '<div style="font-size:0.85rem;color:rgba(245,240,232,0.55);line-height:1.6;">Enter this code in the Quarry app to sign in.<br>It expires in 10 minutes.</div>' +
          '<div style="margin-top:32px;padding-top:16px;border-top:1px solid rgba(196,149,106,0.15);font-size:0.75rem;color:rgba(245,240,232,0.4);">If you didn\'t request this, you can ignore this email.</div>' +
        '</div>',
    }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SENDGRID_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return reply(405, { ok: false, error: 'POST only' });
  if (!SECRET)            return reply(500, { ok: false, error: 'MEMBER_AUTH_SECRET not configured' });
  if (!SENDGRID_API_KEY)  return reply(500, { ok: false, error: 'SENDGRID_API_KEY not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const email = (body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return reply(400, { ok: false, error: 'Valid email required' });
  }

  const minute = Math.floor(Date.now() / 60000);
  const code = codeForMinute(email, minute);

  try {
    const result = await sendEmail(email, code);
    if (result.status >= 400) {
      return reply(500, { ok: false, error: 'SendGrid error ' + result.status, detail: result.body });
    }
    return reply(200, { ok: true, message: 'Code sent. Check your email.', expiresInMinutes: 10 });
  } catch (e) {
    return reply(500, { ok: false, error: 'Send failed: ' + e.message });
  }
};

// redeploy: 1777851734.1665862
