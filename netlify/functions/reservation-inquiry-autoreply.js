// ============================================================================
// reservation-inquiry-autoreply.js
//
// Fired by a Netlify Forms "outgoing webhook" notification the instant a
// customer submits the Group Reservation or Private Event Inquiry form (see
// quarry-reservations.html / quarry-private-events.html). Sends an immediate
// "thanks, let me double-check and get back to you" email that restates
// whatever the form already captured (date, time, guests, indoor/outdoor,
// catering) and asks only for whatever's actually missing -- most
// submissions already have everything, since both forms require these
// fields, but this stays defensive in case a field is blank or the form
// changes later.
//
// It does NOT check calendar availability or confirm anything itself --
// that's a deliberate human decision Penny/the owner makes from the
// Reservation Inquiries admin panel (see reservation-inquiry-decide.js).
// It also doesn't drop the inquiry straight into that admin queue: the email
// asks "want us to look into that date?" with a confirm link
// (reservation-inquiry-confirm-interest.js), and only a click on that link
// moves it into the queue -- staff never spend time chasing a request the
// customer never actually confirmed they still wanted.
//
// After sending, marks the inquiry 'awaiting_customer_confirm' via
// update-reservation-status.js.
//
// POST /.netlify/functions/reservation-inquiry-autoreply?wh=<WEBHOOK_SHARED_SECRET>
// Body: the raw Netlify Forms submission-created payload.
//
// Setup (one-time, per form): Netlify site → Forms → the form → Settings →
// add an "Outgoing webhook" notification pointing at this URL with the
// secret in the query string. Only "reservations" and "private-events" need
// this -- wedding-tour inquiries go to Jacqueline's separate wedding-portal
// workflow, not this one.
// ============================================================================

const https = require('https');
const crypto = require('crypto');

const WEBHOOK_SECRET = process.env.RESERVATION_WEBHOOK_SECRET || '';
const CONFIRM_SECRET = process.env.RESERVATION_CONFIRM_SECRET || '';
const SITE_URL = process.env.URL || 'https://thequarrystl.com';

// The confirm link's token is just "<submissionId>.<hmac>" -- see
// reservation-inquiry-confirm-interest.js for the matching verification.
// Signed so a customer can only confirm their OWN inquiry, not guess at
// someone else's submission id and trigger their queue entry.
function confirmToken(submissionId) {
    if (!CONFIRM_SECRET) return '';
    return submissionId + '.' + crypto.createHmac('sha256', CONFIRM_SECRET).update(submissionId).digest('hex');
}

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function sendGridEmail(to, subject, htmlBody, fromEmail, fromName) {
    fromEmail = fromEmail || 'management@thequarrystl.com';
    fromName = fromName || 'The Quarry';
    const payload = JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: fromName },
        reply_to: { email: 'management@thequarrystl.com', name: 'The Quarry' },
        subject,
        content: [{ type: 'text/html', value: htmlBody }],
        categories: ['reservation-inquiry-autoreply']
    });
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.sendgrid.com',
            path: '/v3/mail/send',
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY,
                'Content-Type': 'application/json',
            },
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, body });
                else reject(new Error(`SendGrid ${res.statusCode}: ${body}`));
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function fmtDate(d) {
    if (!d) return '';
    try {
        const dt = new Date(d + 'T12:00:00');
        if (isNaN(dt.getTime())) return d;
        return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    } catch (_) { return d; }
}

// Builds the "here's what we have, here's what's missing" body. Only the
// fields the form actually left blank get asked for -- both forms require
// date/time/guests/location(or venue)/catering, so in practice this list is
// usually empty and the email is pure confirmation-of-receipt.
function buildEmail(inq, confirmUrl) {
    const haveRows = [];
    const missing = [];

    if (inq.eventDate) haveRows.push(['Date', fmtDate(inq.eventDate)]); else missing.push('your preferred date');
    if (inq.eventTime) haveRows.push(['Time', inq.eventTime]); else missing.push('a preferred time');
    if (inq.guests) haveRows.push(['Guests', inq.guests]); else missing.push('how many guests');
    if (inq.location) haveRows.push(['Seating', inq.location]); else missing.push('your seating preference (Back Patio, Turf, or Inside)');
    if (inq.catering) haveRows.push(['Catering', inq.catering === 'Yes' ? 'Requested' : 'Not needed']); else missing.push('whether you\'d like catering');
    if (inq.occasion) haveRows.push(['Occasion', inq.occasion]);

    const rowsHtml = haveRows.map(([label, val]) =>
        `<p style="margin:4px 0"><b>${esc(label)}:</b> ${esc(val)}</p>`
    ).join('');

    const missingHtml = missing.length
        ? `<p style="margin:20px 0 8px">Could you also let us know ${missing.map(esc).join(', ')}? Just reply to this email.</p>`
        : '';

    const cateringNote = inq.catering === 'Yes'
        ? '<p>Since you\'d like catering, we\'ll send over our Event &amp; Catering menu once your date is secured.</p>'
        : '';

    const confirmButton = confirmUrl
        ? '<div style="text-align:center;margin:28px 0">' +
          `<a href="${esc(confirmUrl)}" style="display:inline-block;background:#B8933A;color:#1A0E08;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:4px;">Yes, please check availability &rarr;</a>` +
          '</div>'
        : '';

    return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
        '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
        '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
        '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">Thanks for reaching out!</h2>' +
        `<p>Hi ${esc(inq.firstName || inq.name || 'there')}, thank you for your interest in The Quarry` +
        (inq.occasion ? ` for your ${esc(inq.occasion.toLowerCase())}` : '') + `!</p>` +
        '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
        '<p style="margin:0 0 8px;color:#8a6d1f;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em">What we have so far</p>' +
        rowsHtml +
        '</div>' +
        missingHtml +
        cateringNote +
        '<p>Would you like us to look into securing that time and date for you? Click below and we\'ll have an answer for you soon!</p>' +
        confirmButton +
        '<p>Questions in the meantime? Call us at <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a>.</p></div>' +
        '<div style="background:#1A0E08;padding:16px;text-align:center">' +
        '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>';
}

function normalize(submission, formName) {
    const d = (submission && submission.data) || {};
    return {
        id: submission.id,
        formName,
        name: d.name || ((d.first_name || '') + ' ' + (d.last_name || '')).trim() || '',
        firstName: d.first_name || (d.name ? d.name.split(' ')[0] : ''),
        email: (d.email || '').toLowerCase(),
        occasion: d.occasion || '',
        eventDate: d.date || '',
        eventTime: d.time || '',
        guests: d.guests || d.party_size || '',
        location: d.location || d.venue || '',
        catering: d.catering || '',
    };
}

async function markAwaitingCustomerConfirm(submissionId) {
    // A token-less internal call isn't possible (update-reservation-status.js
    // requires a session token) -- so this writes the override file directly via
    // the same data-store helper, mirroring what update-reservation-status.js does,
    // rather than trying to mint a fake admin session just to call itself.
    try {
        const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`);
        const existing = r.ok ? await r.json() : null;
        const data = (existing && existing.decoded) || { overrides: {} };
        const sha = existing ? existing.sha : null;
        data.overrides = data.overrides || {};
        const now = new Date().toISOString();
        const prev = data.overrides[submissionId] || {};
        const history = Array.isArray(prev.history) ? prev.history : [];
        history.push({ from: prev.status || 'not_contacted', to: 'awaiting_customer_confirm', by: 'auto-reply', note: 'Instant auto-reply sent', at: now });
        data.overrides[submissionId] = {
            status: 'awaiting_customer_confirm',
            note: prev.note || '',
            updatedAt: now,
            updatedBy: 'auto-reply',
            history,
            hidden: !!prev.hidden,
        };
        data.updatedAt = now;
        await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ json: data, sha, message: `reservations: ${submissionId.slice(0, 8)} → awaiting_customer_confirm (auto-reply)` })
        });
    } catch (_) { /* best-effort; the email having sent matters more than this flag */ }
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { ok: false, error: 'POST only' });
    if (!WEBHOOK_SECRET) return respond(503, { ok: false, error: 'RESERVATION_WEBHOOK_SECRET not configured' });

    const q = event.queryStringParameters || {};
    if (q.wh !== WEBHOOK_SECRET) return respond(401, { ok: false, error: 'unauthorized' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { ok: false, error: 'invalid_json' }); }

    // Netlify's outgoing-webhook payload IS the submission object itself
    // (id, form_id, form_name/form_name, data, created_at, ...).
    const submission = body.payload || body;
    const formName = submission.form_name || submission.form_id_name || '';
    if (!['reservations', 'private-events'].includes(formName)) {
        // Not a form this endpoint handles (or Netlify sent a test ping) -- ack quietly.
        return respond(200, { ok: true, skipped: true });
    }

    const inq = normalize(submission, formName);
    if (!inq.email || !inq.id) return respond(200, { ok: true, skipped: true, reason: 'missing email or id' });

    try {
        const subject = 'Thanks for reaching out to The Quarry!';
        const confirmUrl = CONFIRM_SECRET
            ? `${SITE_URL}/.netlify/functions/reservation-inquiry-confirm-interest?t=${encodeURIComponent(confirmToken(inq.id))}`
            : '';
        await sendGridEmail(inq.email, subject, buildEmail(inq, confirmUrl));
        await markAwaitingCustomerConfirm(inq.id);
        return respond(200, { ok: true, emailed: inq.email });
    } catch (err) {
        console.error('reservation-inquiry-autoreply error:', err.message);
        return respond(500, { ok: false, error: err.message });
    }
};
