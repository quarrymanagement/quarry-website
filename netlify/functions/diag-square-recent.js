// ============================================================================
// diag-square-recent.js
// One-off diagnostic: list Square payments from the last 7 days and show whether
// they were captured into events.json. Protected by ADMIN_PASSWORD_HASH or a
// query-string token check.
// Hit:  /.netlify/functions/diag-square-recent?token=quarry2026
// ============================================================================
const https = require('https');

function sqApi(method, path) {
  const env = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  const host = env === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: host, path: path, method: method,
      headers: {
        'Authorization': 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
        'Square-Version': '2024-12-18',
        'Content-Type': 'application/json'
      }
    }, function(res) {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchJSON(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, function(res) {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

exports.handler = async function(event) {
  // simple guard
  const qs = event.queryStringParameters || {};
  if (qs.token !== 'quarry2026') {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  const begin = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const list = await sqApi('GET', '/v2/payments?begin_time=' + encodeURIComponent(begin) + '&sort_order=DESC&limit=100');
  const payments = list.payments || [];

  // For each payment, fetch its order metadata
  const out = [];
  for (const p of payments) {
    let meta = {};
    if (p.order_id) {
      try {
        const o = await sqApi('GET', '/v2/orders/' + p.order_id);
        meta = (o.order && o.order.metadata) || {};
      } catch (e) { /* skip */ }
    }
    out.push({
      payment_id: p.id,
      created_at: p.created_at,
      status: p.status,
      amount: ((p.total_money && p.total_money.amount) || 0) / 100,
      order_id: p.order_id || null,
      bookingType: meta.bookingType || null,
      eventId: meta.eventId || null,
      customerName: meta.customerName || null,
      customerEmail: meta.customerEmail || null,
      ticketTier: meta.ticketTier || null,
      partySize: meta.partySize || null
    });
  }

  // Cross-check against events.json registrations
  let recorded = {};
  try {
    const ej = await fetchJSON('https://thequarrystl.com/events.json');
    const topRegs = ej.registrations || {};
    Object.keys(topRegs).forEach(eid => {
      (topRegs[eid] || []).forEach(r => {
        if (r.paymentId) recorded[r.paymentId] = eid;
      });
    });
  } catch (e) { /* ignore */ }

  out.forEach(p => { p.recordedInEventsJson = recorded[p.payment_id] ? recorded[p.payment_id] : false; });

  // Filter to event-related + missing
  const eventPayments = out.filter(p => p.bookingType === 'event' || p.eventId);
  const orphans = eventPayments.filter(p => !p.recordedInEventsJson);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      window_begin: begin,
      total_payments_returned: payments.length,
      event_payments: eventPayments,
      orphan_count: orphans.length,
      orphans: orphans
    }, null, 2)
  };
};
