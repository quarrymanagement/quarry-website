// ============================================================================
// list-golf-bookings.js
//
// Returns all PAID golf-bay bookings within a date range, pulled directly
// from Stripe's checkout.sessions list. Used by the admin Golf Schedule tab.
//
// GET /.netlify/functions/list-golf-bookings?startDate=2026-05-01&endDate=2026-08-01
// ============================================================================

const Stripe = require('stripe');
const { readBlob } = require('./_blobs');

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

    // Merge in pay-at-venue / manual bookings from blob storage (which never
    // hit Stripe). Walk each day in the range and read the blob via the SDK
    // helper (the prior direct REST call was silently returning empty data).
    {
        // Identity here has to be paymentId-or-sessionId, not sessionId alone.
        // The site switched golf-bay checkout from Stripe to Square back on
        // 2026-08-10 (square-checkout.js replaced create-checkout.js), and
        // square-webhook.js writes real, paid Square bookings into this same
        // golf-bookings/{date} blob with a `paymentId` field -- it never had
        // a `sessionId` at all. The old filter here only kept blob rows whose
        // `sessionId` started with "admin-" or had paymentMethod
        // "pay-at-venue", on the assumption Stripe's own list already had
        // everything else. Every real Square-paid booking has neither of
        // those, so `!b.sessionId` was true first and the row was dropped
        // before the admin/pay-at-venue check even ran -- every paid golf
        // booking since the Square switch has been invisible on this page.
        const seenIds = new Set(all.map(b => b.sessionId));
        let cursor = startDate;
        let dayCount = 0;
        while (cursor <= endDate && dayCount < 365) {
            try {
                const data = await readBlob('golf-bookings/' + cursor);
                if (data) {
                    for (const b of (data.bookings || [])) {
                        const id = b.paymentId || b.sessionId || '';
                        if (!id || seenIds.has(id)) continue;
                        seenIds.add(id);
                        const isSquare = b.source === 'square' || !!b.paymentId;
                        all.push({
                            sessionId:       id,
                            amountTotal:     0,
                            amountPaid:      b.amountPaid || (isSquare ? '' : 'Pay at venue'),
                            currency:        'usd',
                            createdAt:       b.bookedAt || new Date().toISOString(),
                            customerName:    b.customerName    || '',
                            customerEmail:   b.customerEmail   || '',
                            customerPhone:   b.customerPhone   || '',
                            bay:             b.bay || '',
                            date:            b.date || cursor,
                            time:            b.time || '',
                            duration:        b.duration || '50 Minutes',
                            players:         b.players  || '',
                            extraBalls:      parseInt(b.extraBalls || '0', 10),
                            extraBallsPrice: parseInt(b.extraBallsPrice || '0', 10),
                            coupon:          '',
                            paymentMethod:   b.paymentMethod || (isSquare ? 'square' : 'pay-at-venue'),
                            addedBy:         b.addedBy || (isSquare ? '' : 'admin'),
                            notes:           b.notes || ''
                        });
                    }
                }
            } catch (_) { /* skip days that error */ }
            cursor = addDays(cursor, 1);
            dayCount++;
        }
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
