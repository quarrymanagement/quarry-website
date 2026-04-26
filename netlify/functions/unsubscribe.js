// ============================================================================
// unsubscribe.js
//
// CAN-SPAM-compliant unsubscribe handler.
//
// GET  /.netlify/functions/unsubscribe?email=foo@bar.com
//   → Renders a friendly confirmation page; suppresses the contact in SendGrid;
//     logs the event so it shows in the Performance dashboard.
//
// POST /.netlify/functions/unsubscribe { email, draftId? }
//   → Same suppression; returns JSON.
//
// SendGrid suppression: POST /v3/asm/suppressions/global { recipient_emails: [..] }
// (Global suppression — the contact will never receive Marketing Campaigns or
//  v3/mail/send messages from this account.)
// ============================================================================

const fetch = require('node-fetch');

const SG_KEY = process.env.SENDGRID_API_KEY;
const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

function htmlPage({ ok, email, message }) {
    const color = ok ? '#16a34a' : '#dc2626';
    const headline = ok ? "You've been unsubscribed." : "Something went wrong.";
    const body = ok
        ? `<p>We've removed <strong>${escapeHtml(email)}</strong> from all marketing emails. You won't receive any more campaigns from us.</p>
           <p>If this was a mistake, just reply to any past email and we'll happily put you back on the list.</p>`
        : `<p>${escapeHtml(message || 'Please try again or email us directly.')}</p>`;
    return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe | The Quarry</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600&family=Montserrat:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Montserrat', sans-serif; background:#f4f5f7; color:#1c1f26; margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:2rem; }
  .card { background:#fff; max-width:520px; width:100%; padding:2.5rem 2rem; border-radius:12px; box-shadow:0 6px 30px rgba(0,0,0,0.06); text-align:center; }
  .brand { font-family:'Playfair Display', Georgia, serif; font-size:1.5rem; color:#1c1f26; letter-spacing:0.04em; margin-bottom:1.5rem; padding-bottom:1rem; border-bottom:2px solid #9a7b2a; }
  h1 { color:${color}; font-family:'Playfair Display', Georgia, serif; font-weight:600; font-size:1.4rem; margin:1rem 0; }
  p { line-height:1.6; color:#4b5263; margin:0.85rem 0; }
  a { color:#9a7b2a; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .home { display:inline-block; margin-top:1.5rem; padding:0.55rem 1.25rem; background:#9a7b2a; color:#fff; border-radius:6px; font-weight:600; }
</style></head>
<body><div class="card">
  <div class="brand">THE QUARRY</div>
  <h1>${headline}</h1>
  ${body}
  <a class="home" href="${SITE_URL}">Visit thequarrystl.com</a>
</div></body></html>`;
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function suppress(email) {
    if (!SG_KEY) throw new Error('SENDGRID_API_KEY not configured');
    const r = await fetch('https://api.sendgrid.com/v3/asm/suppressions/global', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_emails: [email] })
    });
    if (!r.ok) {
        const body = await r.text();
        throw new Error(`SG suppression failed (${r.status}): ${body.slice(0, 200)}`);
    }
    return await r.json();
}

async function logUnsubEvent(email, draftId) {
    // Append to marketing_events.json so the dashboard shows it
    try {
        const url = `${SITE_URL}/.netlify/functions/data-store?file=marketing_events.json`;
        const r = await fetch(url);
        if (!r.ok) return;
        const data = await r.json();
        const file = data.decoded || { events: [], aggregates: {} };
        file.events = Array.isArray(file.events) ? file.events : [];
        file.events.push({
            ts: new Date().toISOString(),
            type: 'unsubscribe',
            draftId: draftId || null,
            email: (email || '').toLowerCase(),
            sgEventId: `unsub:${Date.now()}:${email}`
        });
        if (draftId) {
            file.aggregates = file.aggregates || {};
            file.aggregates[draftId] = file.aggregates[draftId] || { unsubscribe: 0 };
            file.aggregates[draftId].unsubscribe = (file.aggregates[draftId].unsubscribe || 0) + 1;
        }
        file.updatedAt = new Date().toISOString();
        await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ json: file, sha: data.sha, message: `unsubscribe: ${email}` })
        });
    } catch (_) { /* best-effort log; don't block unsubscribe */ }
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };

    const params = event.queryStringParameters || {};
    let email = (params.email || '').trim().toLowerCase();
    let draftId = params.draftId || params.draft_id || null;

    if (event.httpMethod === 'POST') {
        try {
            const body = JSON.parse(event.body || '{}');
            email = (body.email || email || '').trim().toLowerCase();
            draftId = body.draftId || draftId;
        } catch (_) {}
    }

    if (!email || !email.includes('@')) {
        if (event.httpMethod === 'GET') {
            return { statusCode: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
                     body: htmlPage({ ok: false, email: '', message: 'Missing email parameter.' }) };
        }
        return { statusCode: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                 body: JSON.stringify({ ok: false, error: 'email required' }) };
    }

    let ok = true, message = '';
    try {
        await suppress(email);
        await logUnsubEvent(email, draftId);
    } catch (err) {
        ok = false;
        message = err.message;
    }

    if (event.httpMethod === 'GET') {
        return { statusCode: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
                 body: htmlPage({ ok, email, message }) };
    }
    return { statusCode: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
             body: JSON.stringify({ ok, email, message }) };
};
