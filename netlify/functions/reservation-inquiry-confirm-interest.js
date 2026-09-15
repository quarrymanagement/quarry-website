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
// On a real (non-repeat) click this also sends two emails:
//   - to the customer: confirms the click landed and we're on it
//   - to management@thequarrystl.com: tells staff a customer confirmed and
//     spells out exactly what to do next in the admin panel
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
const https = require('https');

const CONFIRM_SECRET = process.env.RESERVATION_CONFIRM_SECRET || '';
const SITE_URL = process.env.URL || 'https://thequarrystl.com';
const NETLIFY_TOKEN = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function fmtDate(d) {
    if (!d) return '';
    try {
        const dt = new Date(d + 'T12:00:00');
        if (isNaN(dt.getTime())) return d;
        return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    } catch (_) { return d; }
}

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

function sendGridEmail(to, subject, htmlBody) {
    const payload = JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: 'management@thequarrystl.com', name: 'The Quarry' },
        reply_to: { email: 'management@thequarrystl.com', name: 'The Quarry' },
        subject,
        content: [{ type: 'text/html', value: htmlBody }],
        categories: ['reservation-inquiry-confirm-interest']
    });
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
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

function emailShell(heading, bodyHtml) {
    return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
        '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
        '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
        '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">' + esc(heading) + '</h2>' + bodyHtml + '</div>' +
        '<div style="background:#1A0E08;padding:16px;text-align:center">' +
        '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>';
}

// Pulls the actual submitted fields for this one inquiry from Netlify's Forms
// API -- confirm-interest only gets a bare submissionId from the signed link,
// so this is what turns that into an actual name/email/date to email about.
async function fetchSubmission(submissionId) {
    if (!NETLIFY_TOKEN) return null;
    try {
        const r = await fetch(`https://api.netlify.com/api/v1/submissions/${submissionId}`, {
            headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}` },
        });
        if (!r.ok) return null;
        const sub = await r.json();
        const d = sub.data || {};
        return {
            name: d.name || ((d.first_name || '') + ' ' + (d.last_name || '')).trim() || '',
            firstName: d.first_name || (d.name ? d.name.split(' ')[0] : ''),
            email: (d.email || '').toLowerCase(),
            phone: d.phone || '',
            occasion: d.occasion || '',
            eventDate: d.date || '',
            eventTime: d.time || '',
            guests: d.guests || d.party_size || '',
        };
    } catch (_) { return null; }
}

function customerEmail(inq) {
    return emailShell('Got It — We\'re On It!',
        `<p>Hi ${esc(inq.firstName || inq.name || 'there')}, thanks for confirming! We've received it and are checking our calendar` +
        (inq.eventDate ? ` for ${esc(fmtDate(inq.eventDate))}` : '') + ` now.</p>` +
        '<p>We\'ll be in touch soon with an answer. In the meantime, feel free to call us at <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> with any questions.</p>'
    );
}

function managementEmail(inq, submissionId) {
    const rows = [
        ['Name', inq.name],
        ['Email', inq.email],
        ['Phone', inq.phone],
        ['Occasion', inq.occasion],
        ['Date', fmtDate(inq.eventDate)],
        ['Time', inq.eventTime],
        ['Guests', inq.guests],
    ].filter(([, v]) => v).map(([l, v]) => `<p style="margin:4px 0"><b>${esc(l)}:</b> ${esc(v)}</p>`).join('');

    return emailShell('Customer Confirmed — Action Needed',
        `<p><b>${esc(inq.name || inq.email)}</b> just clicked "Yes, please check availability" and is now waiting on a decision.</p>` +
        `<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">${rows}</div>` +
        '<p style="margin:20px 0 8px"><b>What to do:</b></p>' +
        '<ol style="margin:0;padding-left:20px;line-height:1.8">' +
        '<li>Open the admin panel and go to <b>Reservation Inquiries</b> (under Reservations)</li>' +
        `<li>Find this inquiry (filter by <b>Awaiting my decision</b>, or search "${esc(inq.name || inq.email)}")</li>` +
        '<li>Check the Venue Calendar for that date and time</li>' +
        '<li>Click <b>🗓️ Confirm & Auto-Book</b> if it\'s open — this creates the booking and emails the customer automatically</li>' +
        '<li>Or click <b>📅 Date Conflict — Offer Alternate</b> if it\'s not — this emails them asking for another date</li>' +
        '</ol>' +
        `<p style="margin-top:24px;"><a href="${SITE_URL}/admin/index.html" style="color:#B8933A">Open Reservation Inquiries &rarr;</a></p>`
    );
}

// reservations_status.json is a single shared file protected by an
// optimistic-concurrency check (data-store.js rejects a PUT whose sha
// doesn't match the file's current one). Mirrors the retry loop in
// update-reservation-status.js -- without it, a write that loses a race
// (routine with a background follow-up checker, digests, and admin clicks
// all touching this same file) fails completely silently: no exception,
// no logged error, and the two confirmation emails below still go out as
// if the status change had actually landed, even though it never did.
async function markAwaitingDecision(submissionId) {
    const MAX_ATTEMPTS = 5;
    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`);
            const existing = r.ok ? await r.json() : null;
            const data = (existing && existing.decoded) || { overrides: {} };
            const sha = existing ? existing.sha : null;
            data.overrides = data.overrides || {};
            const now = new Date().toISOString();
            const prev = data.overrides[submissionId] || {};

            // Idempotent: clicking twice (or a link preview bot fetching it once)
            // shouldn't re-log history, re-send both emails, or bump an inquiry
            // that already moved past this stage back down to awaiting_decision.
            // Re-checked fresh on every attempt, since a retry means someone
            // else's write just landed and may have moved this past this stage.
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
            const putRes = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ json: data, sha, message: `reservations: ${submissionId.slice(0, 8)} → awaiting_decision (customer confirmed)` })
            });
            if (!putRes.ok) {
                const err = new Error(`save reservations_status.json: ${putRes.status}`);
                err.status = putRes.status;
                throw err;
            }
            return { already: false, status: 'awaiting_decision' };
        } catch (err) {
            lastErr = err;
            if (err.status === 409 && attempt < MAX_ATTEMPTS - 1) {
                await new Promise((res) => setTimeout(res, 200 + attempt * 300));
                continue;
            }
            break;
        }
    }
    throw lastErr || new Error('markAwaitingDecision failed');
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'GET only' };
    if (!CONFIRM_SECRET) return page('Not Available', 'This link isn\'t configured correctly. Please call us at 636-224-8257 and we\'ll take care of it directly.', false);

    const submissionId = verifyToken((event.queryStringParameters || {}).t);
    if (!submissionId) return page('Link Not Valid', 'This confirmation link looks incomplete or has expired. Please call us at 636-224-8257 and we\'ll take care of it directly.', false);

    try {
        const result = await markAwaitingDecision(submissionId);

        if (!result.already) {
            // Best-effort: the click is already recorded even if these emails
            // fail, so failures here must never turn into an error page for
            // the customer.
            try {
                const inq = await fetchSubmission(submissionId);
                if (inq && inq.email) {
                    await sendGridEmail(inq.email, 'Got It — We\'re On It! — The Quarry', customerEmail(inq));
                    await sendGridEmail('management@thequarrystl.com', `Customer Confirmed: ${inq.name || inq.email}`, managementEmail(inq, submissionId));
                }
            } catch (err) {
                console.error('reservation-inquiry-confirm-interest email error:', err.message);
            }
        }

        return page('Thanks — We\'re On It!', 'We\'ve got your confirmation and are checking our calendar now. We\'ll follow up shortly with an answer!', true);
    } catch (err) {
        console.error('reservation-inquiry-confirm-interest error:', err.message);
        return page('Something Went Wrong', 'We had trouble recording that just now. Please call us at 636-224-8257 and we\'ll take care of it directly.', false);
    }
};
