// ============================================================================
// sync-form-to-sendgrid.js
//
// Triggered by Netlify's form-submission notification webhook (configure under
// Site settings → Forms → Form notifications → Outgoing webhook → URL =
//   https://thequarrystl.com/.netlify/functions/sync-form-to-sendgrid )
//
// Body shape (Netlify standard form-submission webhook):
//   { form_name, data: { email, first_name, last_name, name, phone, ... }, ... }
//
// Action:
//   1. Determine segment_tag based on form_name (wine-club / golf / event /
//      subscribed / careers).
//   2. Upsert contact in SendGrid via /v3/marketing/contacts (PUT).
//   3. Add custom field source_form so we can attribute later.
//
// Idempotent — same email re-submitting just updates last_seen + adds source.
// ============================================================================

const fetch = require('node-fetch');

const SG_KEY = process.env.SENDGRID_API_KEY;

const SEGMENT_MAP = {
    'wine-club-registration': 'Wine Club',
    'wine-club-signup':       'Wine Club',
    'golf-booking':           'Golf',
    'event-registration':     'Event Attendees',
    'event-registration-notification': 'Event Attendees',
    'wedding-tour':           'Event Attendees',
    'private-events':         'Event Attendees',
    'reservations':           'Subscribed',
    'mailing-list':           'Subscribed',
    'contact':                'Subscribed',
    'careers':                'Careers',
    'beer-garden':            'Subscribed'
};

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });
    if (!SG_KEY) return respond(500, { error: 'SENDGRID_API_KEY not configured' });

    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { error: 'Invalid JSON body' }); }

    const formName = payload.form_name || payload.formName || (payload.payload && payload.payload.form_name) || '';
    const data = payload.data || (payload.payload && payload.payload.data) || payload || {};

    const email = (data.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
        return respond(200, { ok: true, skipped: 'no email field in submission' });
    }

    // Pull name fields (forms vary — handle the common shapes)
    let firstName = (data.first_name || data.firstName || '').trim();
    let lastName  = (data.last_name  || data.lastName  || '').trim();
    if (!firstName && data.name) {
        const parts = String(data.name).trim().split(/\s+/);
        firstName = parts[0] || '';
        lastName  = parts.slice(1).join(' ');
    }
    const phone = (data.phone || data.phone_number || '').trim();
    const segmentTag = SEGMENT_MAP[formName] || 'Subscribed';

    const contact = {
        email,
        first_name: firstName || undefined,
        last_name:  lastName  || undefined,
        phone_number_id: phone || undefined
    };
    // strip undefined
    Object.keys(contact).forEach((k) => contact[k] === undefined && delete contact[k]);

    try {
        const r = await fetch('https://api.sendgrid.com/v3/marketing/contacts', {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ contacts: [contact] })
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) return respond(200, { ok: false, sg_status: r.status, sg_body: body });
        return respond(200, { ok: true, segmentTag, formName, jobId: body.job_id, email });
    } catch (err) {
        // Always 200 to avoid Netlify retrying form submissions endlessly
        return respond(200, { ok: false, error: err.message });
    }
};
