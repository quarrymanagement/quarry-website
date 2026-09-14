// ============================================================================
// reservation-inquiry-decide.js
//
// The other half of the automated inquiry flow (see
// reservation-inquiry-autoreply.js for the instant "thanks, let me check"
// email). This is what the admin's Confirm/Deny buttons in Reservation
// Inquiries call once a human has actually looked at the calendar and made
// the call -- nothing here decides availability on its own.
//
// POST /.netlify/functions/reservation-inquiry-decide
// body: {
//   token, submissionId, decision: 'confirm' | 'deny',
//   // identity + original intake fields (client already has these from the
//   // inquiries list -- resending them here avoids a second round-trip):
//   name, firstName, email, phone, occasion, formName,
//   // editable at confirm time, defaulting to what the customer submitted:
//   date, time, guests, location, catering, notes, durationHours,
//   by  // who clicked the button, for the audit trail
// }
//
// decision: 'confirm'
//   - Creates the actual venue_bookings row (via the same Supabase function
//     venue-booking-write.js uses) so it shows up on the Venue Calendar
//     immediately -- guest_count/contact info/catering flag carried over
//     automatically. "Inside" maps to the building space; "Outside" and "No
//     Preference" are left unassigned rather than guessing which patio, so
//     a wrong guess never creates a false double-booking -- staff can pin
//     down the exact space from the Venue Calendar in one click if needed.
//   - Marks the inquiry 'confirmed'.
//   - Emails the customer that they're booked.
//
// decision: 'deny'
//   - Marks the inquiry 'needs_followup' -- it lands right back in the main
//     Reservation Inquiries queue (not a dead-end status of its own) so staff
//     know they're waiting on the customer to name a second date. The
//     "Select Another Date & Confirm" button in the admin panel re-runs the
//     confirm flow above with the new date once the customer replies.
//   - Emails the customer that the date's not available and asks for an
//     alternate.
// ============================================================================

const https = require('https');
const crypto = require('crypto');

const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
    || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const STAFF_SECRET = process.env.STAFF_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168;
const ALLOWED_ROLES = ['owner', 'events_staff'];
const VENUE_AVAILABILITY_KEY = process.env.VENUE_AVAILABILITY_KEY || '';
const VENUE_BOOKING_WRITE_URL = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/venue-booking-write';
const SITE_URL = process.env.URL || 'https://thequarrystl.com';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }

// Verifies either an owner token ("<issued>.<sig>") or a staff token
// ("<issued>.<role>.<sig>") — see verify-admin-password.js for the scheme.
function verifyAnyToken(token) {
    if (!token) return { ok: false };
    const parts = String(token).split('.');
    if (parts.length === 2) {
        const [issued, sig] = parts;
        if (!ADMIN_SECRET || !issued || !sig) return { ok: false };
        if (hmac(issued, ADMIN_SECRET) !== sig) return { ok: false };
        const ageHours = (Date.now() - parseInt(issued, 10)) / (1000 * 3600);
        if (!(ageHours < SESSION_TTL_HOURS)) return { ok: false };
        return { ok: true, role: 'owner' };
    }
    if (parts.length === 3) {
        const [issued, role, sig] = parts;
        if (!STAFF_SECRET || !issued || !role || !sig) return { ok: false };
        if (hmac(`${issued}.${role}`, STAFF_SECRET) !== sig) return { ok: false };
        const ageHours = (Date.now() - parseInt(issued, 10)) / (1000 * 3600);
        if (!(ageHours < SESSION_TTL_HOURS)) return { ok: false };
        return { ok: true, role };
    }
    return { ok: false };
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

function sendGridEmail(to, subject, htmlBody) {
    const payload = JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: 'management@thequarrystl.com', name: 'The Quarry' },
        reply_to: { email: 'management@thequarrystl.com', name: 'The Quarry' },
        subject,
        content: [{ type: 'text/html', value: htmlBody }],
        categories: ['reservation-inquiry-decision']
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

function confirmedEmail(inq) {
    const rows = [
        ['Date', fmtDate(inq.date)],
        ['Time', inq.time],
        ['Guests', inq.guests],
        inq.location ? ['Seating', inq.location] : null,
    ].filter(Boolean).map(([l, v]) => `<p style="margin:4px 0"><b>${esc(l)}:</b> ${esc(v)}</p>`).join('');

    const catering = inq.catering === 'Yes'
        ? '<p>Since you requested catering, here\'s our Event &amp; Catering menu: ' +
          '<a href="https://thequarrystl.com/quarry-catering.html" style="color:#B8933A">View Catering Menu &rarr;</a></p>'
        : '<p>If you\'d like to add catering, just let us know and we\'ll send over our Event &amp; Catering menu.</p>';

    return emailShell('You\'re Confirmed!',
        `<p>Hi ${esc(inq.firstName || inq.name || 'there')}, thank you for confirming! After checking, we have your reservation booked.</p>` +
        `<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">${rows}</div>` +
        catering +
        '<p>Is there any other detail or anything else you need from us? Just reply to this email and let us know — we\'re happy to help with any special requests.</p>' +
        '<p>Questions? Call us at <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a>.</p>'
    );
}

function deniedEmail(inq) {
    return emailShell('About Your Requested Date',
        `<p>Hi ${esc(inq.firstName || inq.name || 'there')}, thanks for your patience while we checked our calendar.</p>` +
        `<p>After checking, it looks like we already have something on ${esc(fmtDate(inq.date) || 'that date')}. Is there another date that would work for you?</p>` +
        '<p>Just reply to this email with a couple of alternate dates and we\'ll check those right away.</p>'
    );
}

// Occasion (as submitted) -> existing venue_bookings.event_type values.
// Anything unmapped falls back to general_reservation (reservations form) or
// private_event (private-events form) -- both already-valid event_types.
const OCCASION_MAP = {
    'birthday': 'birthday',
    'anniversary': 'anniversary',
    'bachelorette / bachelor party': 'bachelorette',
    'retirement': 'retirement_party',
    'holiday celebration': 'holiday_party',
    'holiday party': 'holiday_party',
    'group gathering': 'general_reservation',
    'wedding reception': 'wedding',
    'rehearsal dinner': 'rehearsal_dinner',
    'corporate meeting': 'corporate',
    'team building': 'corporate',
    'company party': 'corporate',
};
function mapEventType(occasion, formName) {
    const key = String(occasion || '').trim().toLowerCase();
    if (OCCASION_MAP[key]) return OCCASION_MAP[key];
    return formName === 'private-events' ? 'private_event' : 'general_reservation';
}

// Same DST-safe Central-time ISO builder used by square-webhook.js.
function buildIsoForCentral(dateStr, hour, minute) {
    const probe = new Date(dateStr + 'T12:00:00Z');
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' });
    const parts = fmt.formatToParts(probe);
    const tzAbbrev = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'CDT';
    const offset = tzAbbrev === 'CDT' ? '-05:00' : '-06:00';
    return `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`;
}
function parseTime12h(t) {
    const m = String(t || '').match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = m[3].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return { hour: h, minute: min };
}

async function writeVenueBooking(inq) {
    const t = parseTime12h(inq.time);
    if (!t) throw new Error('Could not parse a start time from "' + inq.time + '"');
    const durationHours = Number(inq.durationHours) || (inq.formName === 'private-events' ? 4 : 2);
    const startsAt = buildIsoForCentral(inq.date, t.hour, t.minute);
    let endHour = t.hour + durationHours, endMinute = t.minute;
    const endsAt = buildIsoForCentral(inq.date, endHour % 24, endMinute);

    // The reservations form's seating options are Back Patio / Turf / Inside --
    // each maps to a real venue_spaces id now that the form asks for a specific
    // space rather than a vague "outside". Anything else (an older submission
    // still saying "Outside"/"No Preference", or the private-events form's
    // separate venue field) is left unassigned rather than guessed at, so a
    // wrong guess never creates a false double-booking.
    const LOCATION_SPACE_MAP = { 'inside': 'building', 'back patio': 'back-patio', 'turf': 'turf' };
    const locKey = String(inq.location || '').trim().toLowerCase();
    const spaceIds = LOCATION_SPACE_MAP[locKey] ? [LOCATION_SPACE_MAP[locKey]] : [];

    const row = {
        title: `${inq.occasion || 'Reservation'} — ${inq.name || inq.email}`,
        event_type: mapEventType(inq.occasion, inq.formName),
        status: 'confirmed',
        starts_at: startsAt,
        ends_at: endsAt,
        guest_count: inq.guests ? parseInt(inq.guests, 10) || null : null,
        occasion: inq.occasion || null,
        contact_name: inq.name || inq.firstName || null,
        contact_phone: inq.phone || null,
        contact_email: inq.email || null,
        catering_required: inq.catering === 'Yes',
        notes: inq.notes || null,
        source: 'reservation_inquiry_confirmed',
        booked_by: inq.by || 'admin',
        space_ids: spaceIds,
    };

    const r = await fetch(VENUE_BOOKING_WRITE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-access-key': VENUE_AVAILABILITY_KEY },
        body: JSON.stringify(row),
    });
    const body = await r.json();
    if (r.status !== 201) {
        const err = new Error(body.message || body.error || `venue-booking-write ${r.status}`);
        err.details = body;
        throw err;
    }
    return body;
}

// This used to fire-and-forget: it never checked the response, so if it
// failed (a 409 from a concurrent writer to reservations_status.json,
// a network blip, anything) the booking would already be created and the
// customer already emailed "you're confirmed", but the inquiry itself would
// silently stay stuck at its old status forever -- exactly the "booking
// exists but Reservation Inquiries never shows it as confirmed" symptom.
// Now retries once, and the caller gets back whether it actually stuck.
async function setStatus(token, submissionId, status, note, by) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const r = await fetch(`${SITE_URL}/.netlify/functions/update-reservation-status`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, submissionId, status, note, by }),
            });
            const respBody = await r.json().catch(() => ({}));
            if (r.ok && respBody.ok) return { ok: true };
            if (attempt === 0) { await new Promise((res) => setTimeout(res, 400)); continue; }
            return { ok: false, error: respBody.error || `HTTP ${r.status}` };
        } catch (err) {
            if (attempt === 0) { await new Promise((res) => setTimeout(res, 400)); continue; }
            return { ok: false, error: err.message };
        }
    }
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { ok: false, error: 'POST only' });
    if (!VENUE_AVAILABILITY_KEY) return respond(503, { ok: false, error: 'Venue booking is not configured on the server.' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { ok: false, error: 'invalid_json' }); }

    const auth = verifyAnyToken(body.token);
    if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return respond(401, { ok: false, error: 'unauthorized' });

    const { submissionId, decision } = body;
    if (!submissionId) return respond(400, { ok: false, error: 'submissionId required' });
    if (!['confirm', 'deny'].includes(decision)) return respond(400, { ok: false, error: 'decision must be confirm or deny' });
    if (!body.email) return respond(400, { ok: false, error: 'email required' });

    try {
        if (decision === 'deny') {
            await sendGridEmail(body.email, 'About Your Requested Date — The Quarry', deniedEmail(body));
            const statusResult = await setStatus(body.token, submissionId, 'needs_followup', 'Date not available; asked for an alternate — awaiting a second date from the customer.', body.by);
            if (!statusResult.ok) {
                return respond(200, {
                    ok: true, decision: 'deny',
                    warning: `The customer was emailed, but the inquiry's status didn't save (${statusResult.error}). Set it to "Needs Follow-up" manually.`,
                });
            }
            return respond(200, { ok: true, decision: 'deny' });
        }

        // confirm
        const booking = await writeVenueBooking(body);
        await sendGridEmail(body.email, 'You\'re Confirmed! — The Quarry', confirmedEmail(body));
        const statusResult = await setStatus(body.token, submissionId, 'confirmed', `Booked in Venue Calendar (auto): "${booking.booking && booking.booking.title}"`, body.by);
        if (!statusResult.ok) {
            return respond(200, {
                ok: true, decision: 'confirm', booking: booking.booking,
                warning: `The booking was created and the customer was emailed, but the inquiry's status didn't save (${statusResult.error}). Set it to "Confirmed" manually.`,
            });
        }
        return respond(200, { ok: true, decision: 'confirm', booking: booking.booking });
    } catch (err) {
        console.error('reservation-inquiry-decide error:', err.message, err.details || '');
        return respond(500, { ok: false, error: err.message, details: err.details });
    }
};
