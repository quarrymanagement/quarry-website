// ============================================================================
// _receipt-review-shared.js
//
// Shared helpers for the receipt review flow (import-only; the leading "_"
// keeps Netlify from deploying it as its own endpoint).
//
// Receipts that can't be matched to a POS ticket after a fair chance land in
// receipt_review_queue. The Supabase edge function "receipt-review" lists them
// and applies approve/deny. This module calls that function with the shared
// secret (VENUE_AVAILABILITY_KEY), which never reaches a browser.
// ============================================================================
const https = require('https');

const EDGE_URL = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/receipt-review';
const ADMIN_URL = 'https://thequarrystl.com/admin/';

async function callEdge(payload) {
  const key = process.env.VENUE_AVAILABILITY_KEY || '';
  if (!key) throw new Error('VENUE_AVAILABILITY_KEY not configured');
  const r = await fetch(EDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-key': key },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { throw new Error('receipt-review returned non-JSON (' + r.status + ')'); }
  return { status: r.status, body };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildDigestHtml(items) {
  const rows = items.map((i) => {
    const name = esc(((i.first_name || '') + ' ' + (i.last_name || '')).trim() || i.email || 'Unknown');
    const tickets = (i.closest_pos_tickets || [])
      .map((t) => '$' + Number(t.pretip).toFixed(2) + ' (' + esc(t.ticket_name) + ', paid ' + esc(t.paid_at_ct) + ')')
      .join(' &middot; ') || 'No POS tickets found that day';
    return '<tr>' +
      '<td style="padding:10px;border-bottom:1px solid #eee;"><b>' + name + '</b><br><span style="color:#777;font-size:12px;">' + esc(i.email) + '</span></td>' +
      '<td style="padding:10px;border-bottom:1px solid #eee;">' + esc(i.visit_date) + '</td>' +
      '<td style="padding:10px;border-bottom:1px solid #eee;">$' + Number(i.spend_amount).toFixed(2) + '</td>' +
      '<td style="padding:10px;border-bottom:1px solid #eee;">' + esc(i.points_credited) + ' pts</td>' +
      '<td style="padding:10px;border-bottom:1px solid #eee;font-size:12px;color:#555;">Closest POS: ' + tickets + '</td>' +
      '</tr>';
  }).join('');
  return '<div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:20px;text-align:center"><h1 style="color:#B8933A;margin:0;font-size:20px">The Quarry</h1></div>' +
    '<div style="padding:24px">' +
    '<h2 style="color:#2C1A0E;margin-top:0">' + items.length + ' receipt' + (items.length === 1 ? '' : 's') + ' need your decision</h2>' +
    '<p>These customers were credited points, but the system could not match their receipt to a POS ticket after 3+ days. Approve to keep the points, or deny (with a reason) to remove them and notify the customer.</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
    '<tr style="background:#FAF7F2;text-align:left"><th style="padding:10px">Customer</th><th style="padding:10px">Visit</th><th style="padding:10px">Amount</th><th style="padding:10px">Credited</th><th style="padding:10px">Details</th></tr>' +
    rows + '</table>' +
    '<p style="margin-top:24px"><a href="' + ADMIN_URL + '" style="background:#B8933A;color:#1A0E08;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">Open Receipt Review</a></p>' +
    '</div></div>';
}

function sendGrid(subject, html) {
  const payload = JSON.stringify({
    personalizations: [{ to: [{ email: 'management@thequarrystl.com' }] }],
    from: { email: 'management@thequarrystl.com', name: 'The Quarry STL' },
    subject,
    content: [{ type: 'text/html', value: html }],
    categories: ['quarry-receipt-review'],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300) ? resolve() : reject(new Error('SendGrid ' + res.statusCode + ': ' + body.slice(0, 200))));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Sends one digest email if anything needs a decision. Returns what it did.
async function sendDigest() {
  const { status, body } = await callEdge({ action: 'list' });
  if (status !== 200 || !body.ok) throw new Error('list failed: ' + JSON.stringify(body).slice(0, 200));
  const items = body.needs_decision || [];
  if (items.length === 0) return { sent: false, reason: 'nothing needs a decision', waiting: body.waiting_count };
  await sendGrid(items.length + ' receipt' + (items.length === 1 ? '' : 's') + ' need your review - The Quarry', buildDigestHtml(items));
  return { sent: true, count: items.length };
}

module.exports = { callEdge, sendDigest };
