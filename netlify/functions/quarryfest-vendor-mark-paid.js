// ============================================================================
// quarryfest-vendor-mark-paid.js
//
// Admin-only: flips a pending Quarry Fest vendor straight to "booked" and
// sends the same confirmation emails square-webhook.js's
// handleQuarryFestVendor sends on a real Square payment -- without touching
// Square at all. For a vendor who paid cash/check/in person instead of
// through the online link.
//
// POST /.netlify/functions/quarryfest-vendor-mark-paid
// Body: { token, vendorId, amountNote? }
// ============================================================================

const https = require('https');
const crypto = require('crypto');
const { readBlob, writeBlob } = require('./_blobs');

const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const STAFF_SECRET = process.env.STAFF_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168;
const ALLOWED_ROLES = ['owner', 'events_staff'];
const BOOKINGS_PATH = 'quarryfest-vendors/2026-11-07';

function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }
function verifyAnyToken(token) {
  if (!token) return { ok: false };
  const parts = String(token).split('.');
  if (parts.length === 2) {
    const [issued, sig] = parts;
    if (!ADMIN_SECRET || !issued || !sig || hmac(issued, ADMIN_SECRET) !== sig) return { ok: false };
    if (!((Date.now() - parseInt(issued, 10)) / 3600000 < SESSION_TTL_HOURS)) return { ok: false };
    return { ok: true, role: 'owner' };
  }
  if (parts.length === 3) {
    const [issued, role, sig] = parts;
    if (!STAFF_SECRET || !issued || !role || !sig || hmac(`${issued}.${role}`, STAFF_SECRET) !== sig) return { ok: false };
    if (!((Date.now() - parseInt(issued, 10)) / 3600000 < SESSION_TTL_HOURS)) return { ok: false };
    return { ok: true, role };
  }
  return { ok: false };
}

function sendGridEmail(to, subject, htmlBody) {
  const payload = JSON.stringify({
    personalizations: [{ to: [{ email: to }] }],
    from: { email: 'bookings@thequarrystl.com', name: 'The Quarry STL' },
    reply_to: { email: 'management@thequarrystl.com' },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
    categories: ['quarry-fest-vendor'],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, body });
        else reject(new Error('SendGrid ' + res.statusCode + ': ' + body));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function buildCustomerHtml(v, amountStr) {
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">You\'re Registered for Quarry Fest!</h2>' +
    '<p>Hi ' + (v.contactName || 'there') + ', you\'re confirmed as a vendor for Quarry Fest.</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
    '<p style="margin:4px 0"><b>Business:</b> ' + (v.businessName || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Date:</b> Saturday, November 7, 2026</p>' +
    '<p style="margin:4px 0"><b>Time:</b> 12:00 PM - 4:00 PM</p>' +
    '<p style="margin:8px 0 4px;color:#B8933A"><b>Total: ' + amountStr + '</b></p></div>' +
    '<p>More details (setup time, where to park, load-in) will follow as we get closer to the date. ' +
    'Questions in the meantime? <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or reply to this email.</p></div>' +
    '<div style="background:#1A0E08;padding:16px;text-align:center">' +
    '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>';
}
function buildOwnerHtml(v, amountStr) {
  return '<h2 style="color:#B8933A">Quarry Fest Vendor Booked (comp / manual)</h2>' +
    '<p><b>Business:</b> ' + (v.businessName || '-') + '</p>' +
    '<p><b>Contact:</b> ' + (v.contactName || '-') + '</p>' +
    '<p><b>Email:</b> ' + (v.email || '-') + '</p>' +
    '<p><b>Total:</b> ' + amountStr + '</p>' +
    '<p>Marked paid manually by staff (no Square charge).</p>';
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const auth = verifyAnyToken(body.token);
    if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
    }

    const vendorId = String(body.vendorId || '').trim();
    if (!vendorId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'vendorId is required' }) };

    const existing = (await readBlob(BOOKINGS_PATH)) || { vendors: [] };
    const vendors = existing.vendors || [];
    const idx = vendors.findIndex((v) => v.vendorId === vendorId);
    if (idx === -1) return { statusCode: 404, headers: CORS, body: JSON.stringify({ ok: false, error: 'vendor not found' }) };
    if (vendors[idx].status === 'booked') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, already: true }) };
    }

    const amountStr = body.amountNote || '$25.00 (comp)';
    vendors[idx].status = 'booked';
    vendors[idx].paidAt = new Date().toISOString();
    vendors[idx].paymentId = 'manual-comp-' + crypto.randomUUID();
    vendors[idx].amountPaid = amountStr;
    await writeBlob(BOOKINGS_PATH, { vendors });

    const v = vendors[idx];
    if (v.email) {
      try {
        await sendGridEmail(v.email, "You're Registered for Quarry Fest! - The Quarry", buildCustomerHtml(v, amountStr));
      } catch (e) { console.error('quarry fest comp customer email:', e.message); }
    }
    try {
      await sendGridEmail('management@thequarrystl.com', 'Quarry Fest Vendor Booked (comp) - ' + (v.businessName || '?'), buildOwnerHtml(v, amountStr));
    } catch (e) { console.error('quarry fest comp owner email:', e.message); }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, vendor: v }) };
  } catch (err) {
    console.error('quarryfest-vendor-mark-paid error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
