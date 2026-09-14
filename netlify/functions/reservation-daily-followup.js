// ============================================================================
// reservation-daily-followup.js
//
// Scheduled (netlify.toml, 14:30 UTC daily). The lifecycle continuation of
// reservation-inquiry-autoreply.js / reservation-inquiry-confirm-interest.js:
//
//   1. FOLLOW-UP: any reservations/private-events inquiry that's been sitting
//      at awaiting_customer_confirm (auto-reply sent, customer hasn't clicked
//      "check availability" yet) for 3+ days gets ONE reminder email, then
//      moves to awaiting_customer_confirm_followedup so it never sends a
//      second one on its own.
//   2. ESCALATION: an inquiry that's been at awaiting_customer_confirm_followedup
//      for 3+ MORE days (no click even after the reminder) moves to needs_call
//      -- no more automated email; two unanswered emails means it's time for
//      an actual phone call. No email to the customer for this transition.
//      Surfaced to Penny/owners via the digest below rather than paged
//      directly -- Penny's own email address isn't in Netlify anywhere yet;
//      the daily digest is the notification path until that's added.
//   3. DIGEST: emails management@thequarrystl.com a daily summary --
//      how many inquiries need attention (broken down by why), how many
//      actually moved in the last 24h vs sat untouched, and the specific
//      people who need a call or a decision today.
// ============================================================================

const https = require('https');

const SITE_URL = process.env.URL || 'https://thequarrystl.com';
const NETLIFY_TOKEN = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;

const FORM_IDS = {
    reservations: '69c5d0cb30976e00085d79cf',
    'private-events': '69c5d0cb30976e00085d79cd',
};

const FOLLOWUP_AFTER_DAYS = 3;
const ESCALATE_AFTER_DAYS = 3; // additional days after the follow-up email

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function sendGridEmail(to, subject, htmlBody) {
    const payload = JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: 'management@thequarrystl.com', name: 'The Quarry' },
        reply_to: { email: 'management@thequarrystl.com', name: 'The Quarry' },
        subject,
        content: [{ type: 'text/html', value: htmlBody }],
        categories: ['reservation-daily-followup']
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

async function fetchSubmissions(formId) {
    const all = [];
    for (let page = 1; ; page++) {
        const url = `https://api.netlify.com/api/v1/forms/${formId}/submissions?per_page=100&page=${page}`;
        const r = await fetch(url, { headers: { 'Authorization': `Bearer ${NETLIFY_TOKEN}` } });
        if (!r.ok) throw new Error(`Netlify API ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const batch = await r.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);
        if (batch.length < 100) break;
    }
    return all;
}

function normalize(submission, formName) {
    const d = submission.data || {};
    return {
        id: submission.id,
        formName,
        submittedAt: submission.created_at,
        name: d.name || ((d.first_name || '') + ' ' + (d.last_name || '')).trim() || '(no name)',
        firstName: d.first_name || (d.name ? d.name.split(' ')[0] : ''),
        email: (d.email || '').toLowerCase(),
        eventDate: d.date || '',
        occasion: d.occasion || '',
    };
}

function defaultStatus(createdAt) {
    if (!createdAt) return 'not_contacted';
    const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400000;
    if (ageDays > 4) return 'needs_followup';
    return 'not_contacted';
}

async function loadStatusFile() {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`);
    if (!r.ok) return { data: { overrides: {} }, sha: null };
    const d = await r.json();
    return { data: d.decoded || { overrides: {} }, sha: d.sha };
}
async function saveStatusFile(json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=reservations_status.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json, sha, message }),
    });
    if (!r.ok) throw new Error(`save reservations_status.json: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
}

function daysSince(iso) {
    if (!iso) return Infinity;
    return (Date.now() - new Date(iso).getTime()) / 86400000;
}

function followupEmail(inq) {
    return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
        '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
        '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
        '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">Just Following Up!</h2>' +
        `<p>Hi ${esc(inq.firstName || inq.name || 'there')}, thank you again for thinking of us for your` +
        (inq.occasion ? ` ${esc(inq.occasion.toLowerCase())}` : ' event') + `! We just wanted to follow back up and see if you needed anything from us.</p>` +
        '<p>We\'d be delighted to host your party at The Quarry and look forward to hearing back from you soon!</p>' +
        '<p>Questions in the meantime? Call us at <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a>.</p></div>' +
        '<div style="background:#1A0E08;padding:16px;text-align:center">' +
        '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>';
}

exports.handler = async () => {
    if (!NETLIFY_TOKEN) { console.error('NETLIFY_AUTH_TOKEN not configured'); return { statusCode: 500, body: 'not configured' }; }

    // 1) Pull every current reservations/private-events inquiry.
    let inquiries = [];
    for (const [formName, formId] of Object.entries(FORM_IDS)) {
        try {
            const subs = await fetchSubmissions(formId);
            inquiries.push(...subs.map((s) => normalize(s, formName)));
        } catch (err) {
            console.error(`fetchSubmissions(${formName}):`, err.message);
        }
    }

    const { data, sha } = await loadStatusFile();
    data.overrides = data.overrides || {};
    const now = new Date();
    const nowIso = now.toISOString();

    const followedUp = [];
    const escalated = [];
    let dirty = false;

    for (const inq of inquiries) {
        const ov = data.overrides[inq.id] || {};
        const status = ov.status || defaultStatus(inq.submittedAt);
        if (ov.hidden) continue;

        if (status === 'awaiting_customer_confirm' && daysSince(ov.updatedAt) >= FOLLOWUP_AFTER_DAYS) {
            if (inq.email) {
                try {
                    await sendGridEmail(inq.email, 'Just Following Up — The Quarry', followupEmail(inq));
                    followedUp.push(inq);
                } catch (err) {
                    console.error('followup email failed for', inq.id, err.message);
                    continue; // don't advance status if the email didn't actually send
                }
            }
            const history = Array.isArray(ov.history) ? ov.history : [];
            history.push({ from: status, to: 'awaiting_customer_confirm_followedup', by: 'daily-followup', note: '3-day reminder sent', at: nowIso });
            data.overrides[inq.id] = { ...ov, status: 'awaiting_customer_confirm_followedup', updatedAt: nowIso, updatedBy: 'daily-followup', history };
            dirty = true;
        } else if (status === 'awaiting_customer_confirm_followedup' && daysSince(ov.updatedAt) >= ESCALATE_AFTER_DAYS) {
            escalated.push(inq);
            const history = Array.isArray(ov.history) ? ov.history : [];
            history.push({ from: status, to: 'needs_call', by: 'daily-followup', note: 'No response after reminder — needs a phone call', at: nowIso });
            data.overrides[inq.id] = { ...ov, status: 'needs_call', updatedAt: nowIso, updatedBy: 'daily-followup', history };
            dirty = true;
        }
    }

    if (dirty) {
        data.updatedAt = nowIso;
        try {
            await saveStatusFile(data, sha, `reservations: daily follow-up (${followedUp.length} reminded, ${escalated.length} escalated)`);
        } catch (err) {
            console.error('saveStatusFile failed:', err.message);
        }
    }

    // 2) Build the digest against the (now-updated) picture.
    const buckets = { not_contacted: [], needs_followup: [], awaiting_customer_confirm: [], awaiting_customer_confirm_followedup: [], needs_call: [], awaiting_decision: [] };
    let changed24h = 0, untouched = 0, visibleTotal = 0;

    for (const inq of inquiries) {
        const ov = data.overrides[inq.id] || {};
        if (ov.hidden) continue;
        visibleTotal++;
        const status = ov.status || defaultStatus(inq.submittedAt);
        if (buckets[status]) buckets[status].push(inq);

        const history = Array.isArray(ov.history) ? ov.history : [];
        if (!ov.updatedAt && history.length === 0) untouched++;
        else if (ov.updatedAt && daysSince(ov.updatedAt) <= 1) changed24h++;
    }

    const needsAttention = Object.values(buckets).reduce((n, arr) => n + arr.length, 0);

    const bucketLabel = { not_contacted: 'Not contacted', needs_followup: 'Needs follow-up', awaiting_customer_confirm: 'Awaiting customer confirm', awaiting_customer_confirm_followedup: 'Reminded, still waiting', needs_call: 'Needs a phone call', awaiting_decision: 'Awaiting your Confirm/Deny' };
    const bucketRows = Object.entries(buckets).filter(([, arr]) => arr.length).map(([key, arr]) =>
        `<p style="margin:4px 0"><b>${esc(bucketLabel[key])}:</b> ${arr.length}</p>`
    ).join('');

    const priorityList = (label, arr) => arr.length
        ? `<p style="margin:16px 0 4px;color:#8a6d1f;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em">${esc(label)}</p>` +
          arr.map((i) => `<p style="margin:2px 0">• ${esc(i.name)}${i.eventDate ? ' — ' + esc(i.eventDate) : ''} (${esc(i.email)})</p>`).join('')
        : '';

    const digestHtml = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
        '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
        '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">DAILY RESERVATION DIGEST</p></div>' +
        '<div style="padding:32px 24px">' +
        `<p><b>${needsAttention}</b> of ${visibleTotal} open inquiries need attention.</p>` +
        `<p><b>${changed24h}</b> changed status in the last 24 hours &nbsp;·&nbsp; <b>${untouched}</b> have never been touched.</p>` +
        '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' + bucketRows + '</div>' +
        priorityList('Needs a call today', buckets.needs_call) +
        priorityList('Waiting on your Confirm/Deny', buckets.awaiting_decision) +
        `<p style="margin-top:24px;"><a href="${SITE_URL}/admin/index.html" style="color:#B8933A">Open Reservation Inquiries &rarr;</a></p>` +
        '</div></div>';

    try {
        await sendGridEmail('management@thequarrystl.com', `Reservation Digest — ${needsAttention} need attention`, digestHtml);
    } catch (err) {
        console.error('digest email failed:', err.message);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, followedUp: followedUp.length, escalated: escalated.length, needsAttention }) };
};
