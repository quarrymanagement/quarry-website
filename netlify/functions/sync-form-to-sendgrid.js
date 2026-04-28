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
const SITE_URL = process.env.URL || 'https://thequarrystl.com';
const FROM_EMAIL = 'management@thequarrystl.com';
const FROM_NAME  = 'The Quarry STL';
const UNSUB_GROUP = parseInt(process.env.SENDGRID_UNSUB_GROUP_ID || '0', 10);

// Marketing list memberships — every new signup is added to these so future
// campaigns actually reach them. Map by form name.
const LIST_ALL = process.env.SENDGRID_LIST_ALL || '';
const LIST_SUB = process.env.SENDGRID_LIST_SUBSCRIBED || '';

// Determines which SendGrid lists a form submission gets added to.
// LIST_ALL is the full contact universe (used for ops/CRM purposes — never sent to).
// LIST_SUB is the opt-in marketing list (gets all promo emails).
//
// Rules:
//   - Careers: never added to ANY list (job applicants, not customers)
//   - Wine Club / Mailing List: implied marketing consent — both lists
//   - Everything else: depends on the marketing_opt_in checkbox the customer ticked
//     - opt-in = true  → both lists
//     - opt-in = false → LIST_ALL only (we keep the contact for booking purposes,
//                        but don't send marketing emails to them)
function listIdsForForm(formName, marketingOptIn) {
    if (formName === 'careers') return [];
    // Implied consent forms (the act of signing up IS the consent)
    if (formName === 'wine-club-registration' || formName === 'wine-club-signup' ||
        formName === 'mailing-list') {
        return [LIST_ALL, LIST_SUB].filter(Boolean);
    }
    // Everything else: respect the explicit checkbox
    if (marketingOptIn) return [LIST_ALL, LIST_SUB].filter(Boolean);
    return [LIST_ALL].filter(Boolean);  // CRM only, no marketing
}

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
        // 1) Push to SendGrid Contacts AND add to the right marketing lists.
        // SendGrid's PUT /v3/marketing/contacts accepts list_ids as a sibling
        // of contacts — does the upsert + list-add in one call.
        // Honor explicit marketing opt-in (checkbox on the form)
        const marketingOptIn = !!(data.marketing_opt_in === 'yes' || data.marketing_opt_in === true || data.marketing_opt_in === 'on');
        const listIds = listIdsForForm(formName, marketingOptIn);
        const upsertBody = { contacts: [contact] };
        if (listIds.length) upsertBody.list_ids = listIds;
        const r = await fetch('https://api.sendgrid.com/v3/marketing/contacts', {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(upsertBody)
        });
        const body = await r.json().catch(() => ({}));

        // 2) Append to subscribers.json so the CRM tab in admin stays fresh.
        // CRITICAL: must AWAIT this — Netlify Functions kills the runtime as soon
        // as the handler returns, which would terminate any pending fetch calls.
        // Previously this was fire-and-forget which is why every submission since
        // April never reached subscribers.json.
        const submissionData = {
            type: formName,
            timestamp: new Date().toISOString(),
            details: data
        };
        let crmResult = null;
        try {
            crmResult = await appendToCrmFile({ email, firstName, lastName, phone, source: formName, segmentTag, marketingOptIn, submission: submissionData });
        } catch (e) {
            console.warn('subscribers.json sync failed:', e.message);
            crmResult = { error: e.message };
        }

        // 3) Fire a one-time welcome email (only for mailing-list signup, to avoid
        //    sending welcomes to people who just RSVP'd to an event).
        // Same fix as above: must AWAIT or it gets killed when handler returns.
        let welcomeStatus = 'skipped';
        if (formName === 'mailing-list' || formName === 'wine-club-registration' || formName === 'wine-club-signup') {
            try { await sendWelcomeEmail({ email, firstName, segmentTag }); welcomeStatus = 'sent'; }
            catch (e) { console.warn('welcome email failed:', e.message); welcomeStatus = 'failed: ' + e.message; }
        }

        if (!r.ok) return respond(200, { ok: false, sg_status: r.status, sg_body: body, crm: crmResult });
        return respond(200, { ok: true, segmentTag, formName, jobId: body.job_id, email, addedToLists: listIds, crm: crmResult, welcome: welcomeStatus });
    } catch (err) {
        return respond(200, { ok: false, error: err.message });
    }
};

// ---------------------------------------------------------------------------
// Append the new contact to subscribers.json via data-store (idempotent)
// ---------------------------------------------------------------------------
async function appendToCrmFile({ email, firstName, lastName, phone, source, segmentTag, marketingOptIn, submission }) {
    const url = `${SITE_URL}/.netlify/functions/data-store?file=subscribers.json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('load subscribers.json: ' + r.status);
    const data = await r.json();
    const list = Array.isArray(data.decoded) ? data.decoded : [];
    const lower = email.toLowerCase();
    const exists = list.find((s) => (s.email || '').toLowerCase() === lower);
    const now = new Date().toISOString();
    const eventEntry = {
        type: source || 'form',
        timestamp: now,
        marketingOptIn: !!marketingOptIn,
        // Capture meaningful submission fields (not the full payload) for the CRM activity timeline
        details: submission && submission.details ? sanitizeSubmissionDetails(submission.details) : null
    };
    if (exists) {
        // Update existing contact: log this submission as a discrete event, bump activity
        exists.lastActivity = `Form: ${source}`;
        exists.lastActivityDate = now;
        exists.tags = Array.isArray(exists.tags) ? exists.tags : [];
        if (segmentTag && !exists.tags.includes(segmentTag)) exists.tags.push(segmentTag);
        // Promote to Subscribed if they ticked opt-in (never demote — they may have separately subscribed)
        if (marketingOptIn && exists.emailStatus !== 'Subscribed') exists.emailStatus = 'Subscribed';
        exists.events = Array.isArray(exists.events) ? exists.events : [];
        exists.events.push(eventEntry);
        // Update name/phone if we got better info this time
        if (firstName && !exists.firstName) exists.firstName = firstName;
        if (lastName && !exists.lastName)  exists.lastName  = lastName;
        if (phone    && !exists.phone)     exists.phone     = phone;
    } else {
        list.push({
            firstName: firstName || '',
            lastName:  lastName  || '',
            email,
            phone:     phone || '',
            birthdate: '',
            labels:    '',
            created:   now,
            // Honor opt-in: only mark Subscribed if they actually checked the box (or signed up via wine-club / mailing-list which is implied consent)
            emailStatus: marketingOptIn ? 'Subscribed' : 'Not Subscribed',
            smsStatus:   phone ? 'Never subscribed' : '',
            source:    source || 'Website form',
            lastActivity: `Form: ${source}`,
            lastActivityDate: now,
            address:   { street: '', city: '', state: '', zip: '', country: 'United States' },
            events:    [eventEntry],
            tags:      segmentTag ? [segmentTag] : []
        });
    }
    const put = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: list, sha: data.sha, message: `crm: ${exists ? 'update' : 'add'} ${email} (${source})` })
    });
    if (!put.ok) {
        const errText = await put.text().catch(() => '');
        throw new Error(`save subscribers.json: ${put.status} ${errText.slice(0, 200)}`);
    }
    return { action: exists ? 'updated' : 'created', email };
}

// Strip noise from form submissions so we keep meaningful fields without bloat
function sanitizeSubmissionDetails(details) {
    if (!details || typeof details !== 'object') return null;
    const SKIP = new Set([
        'form-name', 'bot-field', 'g-recaptcha-response',
        'first_name', 'firstName', 'last_name', 'lastName', 'name', 'email', 'phone',
        // Already represented elsewhere — don't duplicate
        'marketing_opt_in'
    ]);
    const out = {};
    for (const [k, v] of Object.entries(details)) {
        if (SKIP.has(k)) continue;
        if (v == null || v === '') continue;
        if (typeof v === 'string' && v.length > 500) out[k] = v.slice(0, 500) + '…';
        else out[k] = v;
    }
    return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Welcome email — single short message sent immediately on signup. Sets the
// expectation, gives them something tangible. CAN-SPAM compliant.
// ---------------------------------------------------------------------------
async function sendWelcomeEmail({ email, firstName, segmentTag }) {
    const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
    const subject = firstName
        ? `${firstName}, welcome to The Quarry`
        : 'Welcome to The Quarry';
    const inner = `
<p style="font-size:1rem;color:#1c1f26;margin:0 0 1rem;">${greeting}</p>
<p style="font-size:1rem;color:#4b5263;line-height:1.6;margin:0 0 1rem;">Thanks for joining our list. We don't crowd inboxes &mdash; expect one weekly update on what's happening here, plus the occasional invite to something special: a new vintage release, a band we're excited about, a perfect-weather patio Saturday.</p>
<p style="font-size:1rem;color:#4b5263;line-height:1.6;margin:0 0 1.5rem;">If you ever want a table, a tour, or just a recommendation, you can reply directly to any of our emails. A real person on our team reads every one.</p>
<p style="text-align:center;margin:1.75rem 0 0.5rem;">
  <a href="https://www.thequarrystl.com/quarry-reservations.html?utm_source=email&utm_medium=marketing&utm_campaign=welcome" style="display:inline-block;background:#9a7b2a;color:#ffffff;padding:0.75rem 1.5rem;border-radius:6px;font-weight:600;text-decoration:none;">Reserve a Table</a>
</p>
<p style="font-size:0.85rem;color:#858d9e;text-align:center;margin:0.5rem 0 0;">Wed&ndash;Sun &middot; New Melle, MO</p>
<p style="font-size:0.95rem;color:#4b5263;line-height:1.6;margin:1.5rem 0 0;">See you soon,<br>The team at The Quarry</p>`;

    const aiResp = await fetch(`${SITE_URL}/.netlify/functions/ai-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: 'manual',
            instructions: '__skip_ai__'
        })
    }).catch(() => null);
    // We don't actually need the AI for welcome — just the wrapper. But to keep
    // styling consistent we'll pass the inner HTML through ai-draft's wrapWithFooter
    // by constructing the email locally instead (no AI call to avoid quota burn).
    const html = wrapWithFooterLocal(inner);

    const payload = {
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL },
        personalizations: [{ to: [{ email }] }],
        subject,
        content: [{ type: 'text/html', value: html }],
        categories: ['quarry-marketing:welcome'],
        custom_args: { welcome: 'true', segment: segmentTag || 'Subscribed' },
        tracking_settings: { click_tracking: { enable: true, enable_text: false }, open_tracking: { enable: true } }
    };
    if (UNSUB_GROUP) payload.asm = { group_id: UNSUB_GROUP, groups_to_display: [UNSUB_GROUP] };

    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`SG welcome send: ${r.status} ${t.slice(0, 150)}`);
    }
}

function wrapWithFooterLocal(htmlBody) {
    const LOGO = 'https://thequarrystl.com/assets/quarry-q-logo.png';
    const WEB  = 'https://www.thequarrystl.com';
    const FB   = 'https://www.facebook.com/thequarrystl';
    const IG   = 'https://www.instagram.com/thequarrystl';
    const UNSUB = 'https://www.thequarrystl.com/.netlify/functions/unsubscribe?email={email}';
    const ICON = (svg) => `<span style="display:inline-block;width:18px;height:18px;vertical-align:middle;line-height:0;">${svg}</span>`;
    const webIcon = ICON('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#9a7b2a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>');
    const fbIcon  = ICON('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#9a7b2a" width="18" height="18"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>');
    const igIcon  = ICON('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#9a7b2a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>');

    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:#f4f5f7;"><div style="background:#f4f5f7;padding:2rem 1rem;font-family:'Montserrat',-apple-system,BlinkMacSystemFont,sans-serif;color:#1c1f26;line-height:1.6;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:2rem 1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
<div style="text-align:center;margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:2px solid #9a7b2a;">
  <a href="${WEB}" style="text-decoration:none;display:inline-block;"><img src="${LOGO}" alt="The Quarry" width="72" height="72" style="display:block;margin:0 auto 0.5rem;border:0;outline:none;text-decoration:none;"></a>
  <div style="font-family:'Playfair Display',Georgia,serif;font-size:1.4rem;color:#1c1f26;letter-spacing:0.08em;">THE QUARRY</div>
  <div style="font-family:'Montserrat',sans-serif;font-size:0.7rem;color:#858d9e;letter-spacing:0.18em;text-transform:uppercase;margin-top:0.25rem;">
    <a href="https://www.thequarrystl.com/quarry-drinks.html?utm_source=email&utm_medium=marketing&utm_campaign=welcome&utm_content=drinks" style="color:#9a7b2a;text-decoration:none;">Drinks</a> &middot;
    <a href="https://www.thequarrystl.com/quarry-menu.html?utm_source=email&utm_medium=marketing&utm_campaign=welcome&utm_content=bites" style="color:#9a7b2a;text-decoration:none;">Bites</a> &middot;
    <a href="https://www.thequarrystl.com/quarry-bands.html?utm_source=email&utm_medium=marketing&utm_campaign=welcome&utm_content=music" style="color:#9a7b2a;text-decoration:none;">Live Music</a> &middot;
    <a href="https://www.thequarrystl.com/quarry-golf.html?utm_source=email&utm_medium=marketing&utm_campaign=welcome&utm_content=golf" style="color:#9a7b2a;text-decoration:none;">Golf</a>
  </div>
</div>
${htmlBody}
</div>
<div style="max-width:600px;margin:2rem auto 0;padding:1.5rem 1rem;border-top:1px solid #e0e3e8;font-family:'Montserrat',-apple-system,sans-serif;font-size:0.75rem;color:#858d9e;text-align:center;line-height:1.5;">
  <div style="margin-bottom:0.85rem;">
    <a href="${WEB}" style="color:#9a7b2a;text-decoration:none;margin:0 0.6rem;display:inline-block;" title="thequarrystl.com">${webIcon}</a>
    <a href="${FB}" style="color:#9a7b2a;text-decoration:none;margin:0 0.6rem;display:inline-block;" title="Facebook">${fbIcon}</a>
    <a href="${IG}" style="color:#9a7b2a;text-decoration:none;margin:0 0.6rem;display:inline-block;" title="Instagram">${igIcon}</a>
  </div>
  <div style="margin-bottom:0.5rem;"><strong style="color:#4b5263;">The Quarry</strong> &middot; 3960 Highway Z, New Melle, MO 63385 &middot; (636) 224-8257</div>
  <div>You're receiving this because you signed up at thequarrystl.com. <a href="${UNSUB}" style="color:#858d9e;text-decoration:underline;">Unsubscribe</a> &middot; <a href="https://www.thequarrystl.com/privacy.html" style="color:#858d9e;text-decoration:underline;">Privacy Policy</a></div>
</div>
</div></body></html>`;
}
