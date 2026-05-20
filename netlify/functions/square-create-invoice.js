// ============================================================================
// square-create-invoice.js
//
// Admin-protected endpoint to create + send a Square Invoice.
// Useful for wedding deposits, private events, custom quotes.
//
// Flow:
//   1. Create or find Square customer (by email)
//   2. Create a draft order with line items at the location
//   3. Create a Square invoice tied to that order
//   4. Publish the invoice (sends email via Square)
//
// Required env vars:
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT
//   ADMIN_PASSWORD_HASH (sha256 of admin password; falls back to default)
//
// Request body:
//   {
//     password: "...",
//     customer: { name, email, phone? },
//     lineItems: [ { name, qty, priceCents, note? } ],
//     title: "Wedding deposit - Smith/Jones",
//     description: "Optional invoice description",
//     dueDate: "2026-06-15"   // optional, ISO date
//   }
//
// Response:
//   { invoiceId, publicUrl, status }
// ============================================================================

const https = require('https');
const crypto = require('crypto');

// Default admin password if no hash configured
const DEFAULT_ADMIN_PW = 'quarry2026';
function checkAdminPassword(pw) {
  if (!pw) return false;
  const expectedHash = process.env.ADMIN_PASSWORD_HASH;
  if (expectedHash) {
    const got = crypto.createHash('sha256').update(pw).digest('hex');
    return got === expectedHash;
  }
  return pw === DEFAULT_ADMIN_PW;
}

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

async function findOrCreateCustomer(name, email, phone) {
  // Search by email first
  const searchRes = await squareApi('POST', '/v2/customers/search', {
    query: {
      filter: {
        email_address: { exact: email }
      }
    }
  });
  if (searchRes.customers && searchRes.customers.length > 0) {
    return searchRes.customers[0];
  }
  // Create new customer
  const parts = (name || '').trim().split(/\s+/);
  const given = parts[0] || name || 'Customer';
  const family = parts.slice(1).join(' ') || '';
  const createRes = await squareApi('POST', '/v2/customers', {
    idempotency_key: crypto.randomUUID(),
    given_name: given,
    family_name: family,
    email_address: email,
    phone_number: phone || undefined
  });
  return createRes.customer;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    if (!checkAdminPassword(body.password)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid admin password' }) };
    }
    const cust = body.customer || {};
    const items = body.lineItems || [];
    const title = body.title || 'Invoice from The Quarry';
    const description = body.description || '';
    const dueDate = body.dueDate || null;

    if (!cust.email || !cust.name) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'customer.name and customer.email required' }) };
    }
    if (!items.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'At least one line item required' }) };
    }

    // 1) Find/create customer
    const customer = await findOrCreateCustomer(cust.name, cust.email, cust.phone);
    if (!customer || !customer.id) throw new Error('Failed to create customer');

    // 2) Create draft order
    const orderRes = await squareApi('POST', '/v2/orders', {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        customer_id: customer.id,
        line_items: items.map(function(li) {
          return {
            name: li.name || 'Item',
            quantity: String(li.qty || 1),
            base_price_money: { amount: Math.round(li.priceCents || 0), currency: 'USD' },
            note: li.note || undefined
          };
        }),
        metadata: {
          source: 'admin-invoice',
          createdBy: 'admin-portal'
        }
      }
    });
    const order = orderRes.order;
    if (!order || !order.id) throw new Error('Failed to create order');

    // 3) Create invoice
    const invoiceReq = {
      idempotency_key: crypto.randomUUID(),
      invoice: {
        location_id: process.env.SQUARE_LOCATION_ID,
        order_id: order.id,
        primary_recipient: { customer_id: customer.id },
        payment_requests: [{
          request_type: 'BALANCE',
          due_date: dueDate || undefined,
          automatic_payment_source: 'NONE',
          reminders: dueDate ? [
            { relative_scheduled_days: -3, message: 'Reminder: your invoice is due in 3 days.' }
          ] : undefined
        }],
        delivery_method: 'EMAIL',
        title: title,
        description: description,
        accepted_payment_methods: {
          card: true,
          square_gift_card: false,
          bank_account: false,
          buy_now_pay_later: false,
          cash_app_pay: true
        },
        store_payment_method_enabled: false
      }
    };
    const invoiceRes = await squareApi('POST', '/v2/invoices', invoiceReq);
    const invoice = invoiceRes.invoice;
    if (!invoice || !invoice.id) throw new Error('Failed to create invoice');

    // 4) Publish (sends email)
    const publishRes = await squareApi('POST', '/v2/invoices/' + invoice.id + '/publish', {
      version: invoice.version,
      idempotency_key: crypto.randomUUID()
    });
    const published = publishRes.invoice || invoice;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        invoiceId: published.id,
        publicUrl: published.public_url,
        status: published.status,
        customerId: customer.id,
        orderId: order.id
      })
    };
  } catch (err) {
    console.error('square-create-invoice error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err.message || err), _raw: err.body || null })
    };
  }
};
