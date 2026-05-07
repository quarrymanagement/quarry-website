// ============================================================================
// list-golf-bookings.js
//
// Returns all PAID golf-bay bookings within a date range, pulled directly
// from Stripe's checkout.sessions list. Used by the admin Golf Schedule tab.
//
// GET /.netlify/functions/list-golf-bookings?startDate=2026-05-01&endDate=2026-08-01
// ============================================================================

const Stripe = require('stripe');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET')      return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const q = event.queryStringParameters || {};
    const startDate = q.startDate || todayStrCT();
    const endDate   = q.endDate   || addDays(startDate, 60);

    // Stripe: list all checkout.sessions created in the last 180 days. We then
    // filter client-side by booking date (in metadata.date) so we catch
    // bookings made well in advance.
    const sinceTs = Math.floor((Date.now() - 180 * 24 * 3600 * 1000) / 1000);

    const all = [];
    let starting_after;
    let pages = 0;
    while (pages < 10) { // safety cap
        const list = await stripe.checkout.sessions.list({
            limit: 100,
            created: { gte: sinceTs },
            ...(starting_after ? { starting_after } : {})
        });
        for (const s of list.data) {
            if (s.payment_status !== 'paid') continue;
            const md = s.metadata || {};
            if (md.bookingType !== 'golf' && !md.bay) continue;
            // Only include if booking date falls in range
            const bookingDate = md.date || '';
            if (!bookingDate || bookingDate < startDate || bookingDate > endDate) continue;
            all.push({
                sessionId: s.id,
                amountTotal: s.amount_total,
                amountPaid: '$' + ((s.amount_total || 0) / 100).toFixed(2),
                currency: s.currency,
                createdAt: new Date(s.created * 1000).toISOString(),
                customerName:    md.customerName || '',
                customerEmail:   md.customerEmail || s.customer_details?.email || '',
                customerPhone:   md.customerPhone || '',
                bay:             md.bay || '',
                date:            md.date || '',
                time:            md.time || '',
                duration:        md.duration || '',
                players:         md.players || '',
                extraBalls:      parseInt(md.extraBalls || '0', 10),
                extraBallsPrice: parseInt(md.extraBallsPrice || '0', 10),
                coupon:          md.coupon || ''
            });
        }
        if (!list.has_more) break;
        starting_after = list.data[list.data.length - 1].id;
        pages++;
    }

    // Sort by date then time so the admin grid can render directly
    all.sort((a, b) => {
        const k1 = a.date + ' ' + (a.time || '');
        const k2 = b.date + ' ' + (b.time || '');
        return k1.localeCompare(k2);
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, range: { startDate, endDate }, count: all.length, bookings: all }) };
  } catch (err) {
    console.error('list-golf-bookings error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

function todayStrCT() {
    const now = new Date();
    const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    return ct.getFullYear() + '-' + String(ct.getMonth() + 1).padStart(2, '0') + '-' + String(ct.getDate()).padStart(2, '0');
}
function addDays(yyyymmdd, n) {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
}
