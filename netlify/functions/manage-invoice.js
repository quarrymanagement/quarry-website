// ============================================================================
// manage-invoice.js
//
// Admin actions on a single invoice. Reads/writes SQUARE (migrated from Stripe).
//
// Request:  POST { action, invoiceId }
//   action: 'void'  -> cancel a published invoice (or delete a draft)
//           'send'  -> publish+email a draft; published invoices can't be
//                      resent via Square's API, so we return the pay link
//           'mark_uncollectible' -> Square has no such status; we tell the
//                      caller to use 'void' instead (no destructive surprise)
//
// Response (unchanged shape so the admin UI keeps working):
//   { success, status, message }   (plus url where helpful)
//
// Required env vars: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT
// ============================================================================

const https = require('https');
const crypto = require('crypto');

function squareApi(method, path, body) {
  const env = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  const host = env === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
  const payload = body ? JSON.stringify(body) : '';
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: host,
      path: path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
        'Square-Version': '2024-12-18',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function(res) {
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch (e) { parsed = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(Object.assign(new Error('Square ' + res.statusCode + ': ' + data), { status: res.statusCode, body: parsed }));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!process.env.SQUARE_ACCESS_TOKEN || !process.env.SQUARE_LOCATION_ID) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Square is not configured (SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID missing)' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const action = body.action;
    const invoiceId = body.invoiceId;

    if (!invoiceId || !action) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing invoiceId or action' }) };
    }

    // Square cancel/publish/delete all need the invoice's current version,
    // so fetch it first. This also validates the id (an old Stripe id 404s).
    let invoice;
    try {
      const got = await squareApi('GET', '/v2/invoices/' + encodeURIComponent(invoiceId));
      invoice = got.invoice;
    } catch (e) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invoice not found in Square (it may be an old Stripe invoice): ' + invoiceId }) };
    }
    if (!invoice || !invoice.id) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invoice not found: ' + invoiceId }) };
    }
    const version = invoice.version;
    const status = invoice.status;

    switch (action) {
      case 'void':
      case 'cancel': {
        if (status === 'DRAFT') {
          await squareApi('DELETE', '/v2/invoices/' + encodeURIComponent(invoiceId) + '?version=' + version);
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: 'deleted', message: 'Draft invoice deleted' }) };
        }
        if (status === 'UNPAID' || status === 'SCHEDULED' || status === 'PARTIALLY_PAID') {
          const r = await squareApi('POST', '/v2/invoices/' + encodeURIComponent(invoiceId) + '/cancel', { version: version });
          const inv = r.invoice || {};
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: inv.status || 'CANCELED', message: 'Invoice voided (canceled in Square)' }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, status: status, message: 'Cannot void an invoice that is ' + status }) };
      }

      case 'send': {
        if (status === 'DRAFT') {
          const r = await squareApi('POST', '/v2/invoices/' + encodeURIComponent(invoiceId) + '/publish', { version: version, idempotency_key: crypto.randomUUID() });
          const inv = r.invoice || {};
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, status: inv.status || 'UNPAID', message: 'Invoice published and emailed', url: inv.public_url || invoice.public_url || '' }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, status: status, message: 'This invoice was already sent. Square does not resend via API — share this pay link with the customer.', url: invoice.public_url || '' }) };
      }

      case 'mark_uncollectible': {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, status: status, message: 'Square has no "uncollectible" status. Use Void to cancel this invoice instead.' }) };
      }

      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action. Use: void, send, or mark_uncollectible' }) };
    }

  } catch (err) {
    console.error('Square manage invoice error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, _raw: err.body || null }) };
  }
};
