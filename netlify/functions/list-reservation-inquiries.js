// ============================================================================
// list-reservation-inquiries.js
//
// Pulls form submissions DIRECTLY from Netlify's Forms API for the three
// reservation-related forms (reservations, private-events, wedding-tour).
// Merges with manual status overrides from reservations_status.json.
// Returns a unified, chronologically sorted list for the admin to display.
//
// Why: the old "Potential Reservations" tab depends on someone manually
// labeling Gmail threads, which means real form submissions never appear
// until staff happens to find and tag them. This bypasses that entirely.
//
// GET /.netlify/functions/list-reservation-inquiries
// Returns: { ok: true, inquiries: [...], totalCount: N }
// ============================================================================

const fetch = require('node-fetch');

// Use the existing NETLIFY_AUTH_TOKEN env var (set in Netlify console).
// Fall back to NETLIFY_API_TOKEN if someone sets that name instead.
const NETLIFY_TOKEN = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
const SITE_ID = process.env.NETLIFY_SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';
const SITE_URL = process.env.URL || 'https://thequarrystl.com';

// Form IDs we care about (all three reservation-style forms)
const FORM_IDS = {
    reservations:    '69c5d0cb30976e00085d79cf',  // 76 submissions
    'private-events':'69c5d0cb30976e00085d79cd',  // 21 submissions
    'wedding-tour':  '69d554bafd888300087114a9'   //  6 submissions
};

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

async function fetchSubmissions(formId, perPage) {
    const url = `https://api.netlify.com/api/v1/forms/${formId}/submissions?per_page=${perPage || 100}`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}` } });
    if (!r.ok) throw new Error(`Netlify API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
}

async function loadStatusOverrides() {
    try {
        const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`);
        if (!r.ok) return {};
        const d = await r.json();
        return (d.decoded && d.decoded.overrides) || {};
    } catch (_) { return {}; }
}

// Compute default status when no manual override exists.
// Aged > 4 days with no manual mark → assume needs_followup; otherwise not_contacted.
function defaultStatus(createdAt) {
    if (!createdAt) return 'not_contacted';
    const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400000;
    if (ageDays > 4) return 'needs_followup';
    return 'not_contacted';
}

function normalize(submission, formName) {
    const d = submission.data || {};
    // Submission shape varies per form; collect into a unified inquiry record
    return {
        id: submission.id,
        formName,
        formLabel: formName === 'reservations' ? 'Group Reservation'
                 : formName === 'private-events' ? 'Private Event Inquiry'
                 : formName === 'wedding-tour' ? 'Wedding Tour Request'
                 : formName,
        submittedAt: submission.created_at,
        name: d.name || ((d.first_name || '') + ' ' + (d.last_name || '')).trim() || '(no name)',
        firstName: d.first_name || (d.name ? d.name.split(' ')[0] : ''),
        lastName:  d.last_name  || (d.name ? d.name.split(' ').slice(1).join(' ') : ''),
        email: (d.email || '').toLowerCase(),
        phone: d.phone || '',
        company: d.company || '',
        occasion: d.occasion || (formName === 'wedding-tour' ? 'Wedding' : ''),
        eventDate: d.date || d.wedding_date || '',
        eventTime: d.time || '',
        guests: d.guests || d.party_size || '',
        location: d.location || d.venue || '',
        notes: d.notes || d.message || '',
        marketingOptIn: d.marketing_opt_in === 'yes' || d.marketing_opt_in === 'on' || d.marketing_opt_in === true,
        // Netlify dashboard URL for this submission (deep link)
        netlifyUrl: submission.id
            ? `https://app.netlify.com/sites/roaring-pegasus-444826/forms/${submission.form_id}/submissions/${submission.id}`
            : null,
        rawData: d
    };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (!NETLIFY_TOKEN) return respond(500, { ok: false, error: 'NETLIFY_AUTH_TOKEN env var not configured' });

    try {
        const [overrides, ...formResults] = await Promise.all([
            loadStatusOverrides(),
            ...Object.entries(FORM_IDS).map(([formName, formId]) =>
                fetchSubmissions(formId, 100).then((subs) => ({ formName, subs })).catch((err) => ({ formName, subs: [], error: err.message }))
            )
        ]);

        const inquiries = [];
        const errors = [];
        for (const result of formResults) {
            if (result.error) { errors.push({ formName: result.formName, error: result.error }); continue; }
            for (const sub of result.subs) {
                const inq = normalize(sub, result.formName);
                const ov = overrides[inq.id] || {};
                inq.status = ov.status || defaultStatus(inq.submittedAt);
                inq.statusUpdatedAt = ov.updatedAt || inq.submittedAt;
                inq.statusNote = ov.note || '';
                inq.statusHistory = ov.history || [];
                inquiries.push(inq);
            }
        }
        // Newest first
        inquiries.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));

        return respond(200, {
            ok: true,
            inquiries,
            totalCount: inquiries.length,
            errors,
            generatedAt: new Date().toISOString()
        });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
