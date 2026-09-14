// ============================================================================
// reservation-inquiry-confirm-interest.js
//
// What the "Yes, please check availability" button in the instant auto-reply
// email (reservation-inquiry-autoreply.js) links to. A customer clicking it
// is the actual trigger that moves their inquiry into the admin's
// Confirm/Deny queue -- the form submission alone does NOT do this, on
// purpose, so staff never spend time chasing a request the customer never
// confirmed they still wanted.
//
// GET /.netlify/functions/reservation-inquiry-confirm-interest?t=<token>
// token = "<submissionId>.<hmac>" minted by reservation-inquiry-autoreply.js
// (RESERVATION_CONFIRM_SECRET) -- verified the same way here so a customer
// can only confirm their own inquiry, not guess another submission id.
//
// Renders a small standalone HTML page (not JSON) since a real person is
// clicking this from their email client.
// ============================================================================

const crypto = require('crypto');

const CONFIRM_SECRET = process.env.RESERVATION_CONFIRM_SECRET || '';
const SITE_URL = process.env.URL || 'https://thequarrystl.com';

function page(title, message, ok) {
    const color = ok ? '#16a34a' : '#dc2626';
    const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        `<title>${title} — The Quarry</title>` +
        '<style>body{font-family:Arial,sans-serif;background:#FAF7F2;margin:0;padding:40px 20px;text-align:center;}' +
        '.card{max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:36px 28px;box-shadow:0 2px 12px rgba(0,0,0,0.08);}' +
        'h1{color:#B8933A;font-size:1.1rem;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 20px;}' +
        `h2{color:${color};margin:0 0 12px;}p{color:#2C1A0E;line-height:1.6;}</style></head>` +
        `<body><div class="card"><h1>The Quarry</h1><h2>${title}</h2><p>${message}</p></div></body></html>`;
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: html };
}

function verifyToken(token) {
    if (!token || !CONFIRM_SECRET) return null;
    const parts = String(token).split('.');
    if (parts.length !== 2) return null;
    const [submissionId, sig] = parts;
    const expected = crypto.createHmac('sha256', CONFIRM_SECRET).update(submissionId).digest('hex');
    if (sig !== expected) return null;
    return submissionId;
}

async function markAwaitingDecision(submissionId) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`);
    const existing = r.ok ? await r.json() : null;
    const data = (existing && existing.decoded) || { overrides: {} };
    const sha = existing ? existing.sha : null;
    data.overrides = data.overrides || {};
    const now = new Date().toISOString();
    const prev = data.overrides[submissionId] || {};

    // Idempotent: clicking twice (or a link preview bot fetching it once)
    // shouldn't re-log history or bump an inquiry that already moved past
    // this stage back down to awaiting_decision.
    if (['awaiting_decision', 'confirmed', 'date_conflict', 'lost'].includes(prev.status)) {
        return { already: true, status: prev.status };
    }

    const history = Array.isArray(prev.history) ? prev.history : [];
    history.push({ from: prev.status || 'awaiting_customer_confirm', to: 'awaiting_decision', by: 'customer', note: 'Customer clicked "check availability"', at: now });
    data.overrides[submissionId] = {
        status: 'awaiting_decision',
        note: prev.note || '',
        updatedAt: now,
        updatedBy: 'customer',
        history,
        hidden: !!prev.hidden,
    };
    data.updatedAt = now;
    await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: data, sha, message: `reservations: ${submissionId.slice(0, 8)} → awaiting_decision (customer confirmed)` })
    });
    return { already: false, status: 'awaiting_decision' };
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'GET only' };
    if (!CONFIRM_SECRET) return page('Not Available', 'This link isn\'t configured correctly. Please call us at 636-224-8257 and we\'ll take care of it directly.', false);

    const submissionId = verifyToken((event.queryStringParameters || {}).t);
    if (!submissionId) return page('Link Not Valid', 'This confirmation link looks incomplete or has expired. Please call us at 636-224-8257 and we\'ll take care of it directly.', false);

    try {
        await markAwaitingDecision(submissionId);
        return page('Thanks — We\'re On It!', 'We\'ve got your confirmation and are checking our calendar now. We\'ll follow up shortly with an answer!', true);
    } catch (err) {
        console.error('reservation-inquiry-confirm-interest error:', err.message);
        return page('Something Went Wrong', 'We had trouble recording that just now. Please call us at 636-224-8257 and we\'ll take care of it directly.', false);
    }
};
