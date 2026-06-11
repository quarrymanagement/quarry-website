// ============================================================================
// list-invoices.js
//
// Returns the most recent invoices for the admin panel.
//
// Reads from SQUARE (the business migrated invoicing from Stripe to Square).
// The response shape is intentionally identical to the old Stripe-based
// version so the admin UI needs no changes:
//   { invoices: [ { id, number, customerName, customerEmail, amount,
//                   amountPaid, currency, status, created, dueDate, paid,
//                   description, hostedUrl, pdfUrl } ] }
// Money is in cents; created/dueDate are Unix timestamps (seconds), matching
// what the Stripe version returned.
//
// Required env vars: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT
// ============================================================================

const https = require('https');

function squareApi(method, path) {
  const env = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  const host = env === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: host,
      path: path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
        'Square-Version': '2024-12-18',
        'Content-Type': 'application/json'
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
    req.end();
  });
}

// Map a Square invoice status onto the Stripe-style lowercase status the admin
// UI was built around, so any status styling keeps working.
function mapStatus(sqStatus) {
  switch (sqStatus) {
    case 'PAID':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'paid';
    case 'UNPAID':
    case 'SCHEDULED':
    case 'PARTIALLY_PAID':
    case 'PAYMENT_PENDING':
      return 'open';
    case 'DRAFT':
      return 'draft';
    case 'CANCELED':
    case 'FAILED':
      return 'void';
    default:
      return String(sqStatus || '').toLowerCase();
  }
}

function isoToUnix(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : Math.floor(t / 1000);
}

// due_date comes back as "YYYY-MM-DD"; treat as midnight UTC.
function dateOnlyToUnix(s) {
  if (!s) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  return isNaN(t) ? null : Math.floor(t / 1000);
}

function sumMoney(paymentRequests, field) {
  if (!Array.isArray(paymentRequests)) return 0;
  return paymentRequests.reduce(function(acc, pr) {
    const m = pr && pr[field];
    return acc + ((m && typeof m.amount === 'number') ? m.amount : 0);
  }, 0);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!process.env.SQUARE_ACCESS_TOKEN || !locationId) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Square is not configured (SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID missing)' }) };
  }

  try {
    // Page through Square invoices for this location (cap at ~300 most recent).
    let all = [];
    let cursor = null;
    let pages = 0;
    do {
      let path = '/v2/invoices?location_id=' + encodeURIComponent(locationId) + '&limit=100';
      if (cursor) path += '&cursor=' + encodeURIComponent(cursor);
      const res = await squareApi('GET', path);
      if (Array.isArray(res.invoices)) all = all.concat(res.invoices);
      cursor = res.cursor || null;
      pages++;
    } while (cursor && pages < 3 && all.length < 300);

    const invoiceList = all.map(function(inv) {
      const pr = inv.payment_requests || [];
      const firstDue = pr.length ? pr[0].due_date : null;
      const recipient = inv.primary_recipient || {};
      const name = [recipient.given_name, recipient.family_name].filter(Boolean).join(' ').trim();
      const amountDue = sumMoney(pr, 'computed_amount_money');
      const amountPaid = sumMoney(pr, 'total_completed_amount_money');
      // Pull currency from the first money object we can find.
      let currency = 'usd';
      for (let i = 0; i < pr.length; i++) {
        if (pr[i].computed_amount_money && pr[i].computed_amount_money.currency) {
          currency = String(pr[i].computed_amount_money.currency).toLowerCase();
          break;
        }
      }
      return {
        id: inv.id,
        number: inv.invoice_number || '',
        customerName: name || 'Unknown',
        customerEmail: recipient.email_address || '',
        amount: amountDue,
        amountPaid: amountPaid,
        currency: currency,
        status: mapStatus(inv.status),
        squareStatus: inv.status || '',
        created: isoToUnix(inv.created_at),
        dueDate: dateOnlyToUnix(firstDue),
        paid: inv.status === 'PAID',
        description: inv.description || inv.title || '',
        hostedUrl: inv.public_url || '',
        pdfUrl: inv.public_url || ''
      };
    });

    // Most recent first.
    invoiceList.sort(function(a, b) { return (b.created || 0) - (a.created || 0); });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ invoices: invoiceList })
    };

  } catch (err) {
    console.error('Square list invoices error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, _raw: err.body || null })
    };
  }
};
