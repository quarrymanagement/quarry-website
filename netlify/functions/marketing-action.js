// ============================================================================
// marketing-action.js
//
// Single endpoint that backs the admin UI's Approve / Reject / Edit / Redo
// actions on a draft. Keeping these together so the file rewrite races are
// minimized (one read-modify-write per action).
//
// POST /.netlify/functions/marketing-action
// body: {
//   action: 'approve' | 'reject' | 'edit' | 'redo' | 'reschedule' | 'changeSegment',
//   draftId: '<id>',
//   payload: {
//     // approve:    { approvedBy }
//     // reject:     { reason }
//     // edit:       { subject?, innerHtml? }   — also re-wraps with footer
//     // redo:       { instructions, type? }   — calls ai-draft.js to regenerate
//     // reschedule: { scheduledFor: ISO }
//     // changeSegment: { segment: 'Subscribed'|'Wine Club'|'Golf'|'Event Attendees'|'All' }
//   }
// }
// ============================================================================

const fetch = require('node-fetch');

const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const QUARRY_DATA_KEY = process.env.QUARRY_DATA_KEY || '';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-quarry-key',
    'Content-Type': 'application/json'
};
const respond = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

async function loadJsonFile(file) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`);
    if (!r.ok) throw new Error(`load ${file}: ${r.status}`);
    const d = await r.json();
    return { data: d.decoded || {}, sha: d.sha };
}
async function saveJsonFile(file, json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-quarry-key': QUARRY_DATA_KEY },
        body: JSON.stringify({ json, sha, message })
    });
    if (!r.ok) throw new Error(`save ${file}: ${r.status}`);
    return r.json();
}

function wrapWithFooter(htmlBody) {
    const LOGO_URL = 'https://thequarrystl.com/assets/icons/icon-512.png';
    const WEB_URL  = 'https://www.thequarrystl.com';
    const FB_URL   = 'https://www.facebook.com/thequarrystl';
    const IG_URL   = 'https://www.instagram.com/thequarrystl';
    const UNSUB_URL = 'https://www.thequarrystl.com/.netlify/functions/unsubscribe?email={email}';

    const ICON = (svg) => `<span style="display:inline-block;width:18px;height:18px;vertical-align:middle;line-height:0;">${svg}</span>`;
    const webIcon = ICON('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#9a7b2a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>');
    const fbIcon  = ICON('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#9a7b2a" width="18" height="18"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>');
    const igIcon  = ICON('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#9a7b2a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>');

    const footer = `
<div style="max-width:600px;margin:2rem auto 0;padding:1.5rem 1rem;border-top:1px solid #e0e3e8;font-family:'Montserrat',-apple-system,sans-serif;font-size:0.75rem;color:#858d9e;text-align:center;line-height:1.5;">
  <div style="margin-bottom:0.85rem;">
    <a href="${WEB_URL}" style="color:#9a7b2a;text-decoration:none;margin:0 0.6rem;display:inline-block;" title="thequarrystl.com">${webIcon}</a>
    <a href="${FB_URL}" style="color:#9a7b2a;text-decoration:none;margin:0 0.6rem;display:inline-block;" title="Facebook">${fbIcon}</a>
    <a href="${IG_URL}" style="color:#9a7b2a;text-decoration:none;margin:0 0.6rem;display:inline-block;" title="Instagram">${igIcon}</a>
  </div>
  <div style="margin-bottom:0.5rem;">
    <strong style="color:#4b5263;">The Quarry</strong> &middot; 3960 Highway Z, New Melle, MO 63385 &middot; (636) 224-8257
  </div>
  <div style="margin-bottom:0.5rem;">
    <a href="${WEB_URL}" style="color:#9a7b2a;text-decoration:none;">thequarrystl.com</a> &middot;
    <a href="${FB_URL}" style="color:#9a7b2a;text-decoration:none;">facebook.com/thequarrystl</a> &middot;
    <a href="${IG_URL}" style="color:#9a7b2a;text-decoration:none;">@thequarrystl</a>
  </div>
  <div>
    You're receiving this because you signed up, booked a reservation, or attended an event at The Quarry.
    <a href="${UNSUB_URL}" style="color:#858d9e;text-decoration:underline;">Unsubscribe</a>
  </div>
</div>`;

    return `<div style="background:#f4f5f7;padding:2rem 1rem;font-family:'Montserrat',-apple-system,BlinkMacSystemFont,sans-serif;color:#1c1f26;line-height:1.6;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:2rem 1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
<div style="text-align:center;margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:2px solid #9a7b2a;">
  <a href="${WEB_URL}" style="text-decoration:none;display:inline-block;">
    <img src="${LOGO_URL}" alt="The Quarry" width="72" height="72" style="display:block;margin:0 auto 0.5rem;border:0;outline:none;text-decoration:none;">
  </a>
  <div style="font-family:'Playfair Display',Georgia,serif;font-size:1.4rem;color:#1c1f26;letter-spacing:0.08em;">THE QUARRY</div>
  <div style="font-family:'Montserrat',sans-serif;font-size:0.7rem;color:#858d9e;letter-spacing:0.18em;text-transform:uppercase;margin-top:0.25rem;">Wine &middot; Bites &middot; Live Music &middot; Golf</div>
</div>
${htmlBody}
</div>
${footer}
</div>`;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });

    if (QUARRY_DATA_KEY) {
        const provided = event.headers['x-quarry-key'] || event.headers['X-Quarry-Key'] || '';
        if (provided !== QUARRY_DATA_KEY) return respond(401, { error: 'Missing or invalid x-quarry-key header' });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (_) { return respond(400, { error: 'Invalid JSON' }); }

    const { action, draftId, payload = {} } = body;
    if (!action || !draftId) return respond(400, { error: 'action and draftId required' });

    try {
        const draftsRes = await loadJsonFile('marketing_drafts.json');
        const file = draftsRes.data;
        const drafts = Array.isArray(file.drafts) ? file.drafts : [];
        const idx = drafts.findIndex((d) => d.id === draftId);
        if (idx < 0) return respond(404, { error: 'draft not found' });
        const draft = drafts[idx];

        const now = new Date().toISOString();

        switch (action) {
            case 'approve':
                draft.status = 'approved';
                draft.approvedAt = now;
                draft.approvedBy = payload.approvedBy || 'admin';
                draft.rejectedAt = null;
                draft.rejectionReason = null;
                break;

            case 'reject':
                draft.status = 'rejected';
                draft.rejectedAt = now;
                draft.rejectionReason = payload.reason || '';
                draft.approvedAt = null;
                break;

            case 'edit':
                if (typeof payload.subject === 'string') draft.subject = payload.subject;
                if (typeof payload.innerHtml === 'string') {
                    draft.innerHtml = payload.innerHtml;
                    draft.htmlBody = wrapWithFooter(payload.innerHtml);
                }
                draft.status = 'pending'; // edits drop back to pending so user must re-approve
                draft.approvedAt = null;
                break;

            case 'redo': {
                const instructions = (payload.instructions || '').trim();
                if (!instructions) return respond(400, { error: 'instructions required for redo' });

                // Strip HTML from the previous body so we don't feed a tag soup
                // into the AI prompt — that's what was confusing Claude's JSON
                // output. We just need the gist for context.
                const prevText = String(draft.innerHtml || '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;/gi, ' ')
                    .replace(/&amp;/gi, '&')
                    .replace(/&[a-z]+;/gi, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 600);

                // Up to 2 attempts — Claude occasionally returns malformed JSON
                // on the first call; a clean retry usually works.
                let ai = null, lastErr = '';
                for (let attempt = 0; attempt < 2 && !ai; attempt++) {
                    try {
                        const aiResp = await fetch(`${SITE_URL}/.netlify/functions/ai-draft`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                type: payload.type || draft.type,
                                context: draft.context || {},
                                instructions: `PREVIOUS SUBJECT: ${draft.subject}\nPREVIOUS BODY (plain text excerpt): ${prevText}\n\nUSER FEEDBACK FOR REVISION:\n${instructions}\n\nIMPORTANT: respond with valid JSON only — no preamble, no code fences.`,
                                model: 'claude'
                            })
                        });
                        const aiBody = await aiResp.json().catch(() => ({}));
                        if (aiResp.ok && aiBody.success) {
                            ai = aiBody;
                        } else {
                            lastErr = aiBody.error || `HTTP ${aiResp.status}`;
                        }
                    } catch (e) { lastErr = e.message; }
                }
                if (!ai) {
                    return respond(500, { error: `Redo failed after retries — ${lastErr}. Try simpler instructions or use Edit instead.` });
                }
                draft.subject = ai.subject;
                draft.htmlBody = ai.htmlBody;
                draft.innerHtml = ai.innerHtml || draft.innerHtml;
                draft.regenerationCount = (draft.regenerationCount || 0) + 1;
                draft.lastInstructions = instructions;
                draft.status = 'pending';
                draft.approvedAt = null;
                draft.model = ai.model || draft.model;
                break;
            }

            case 'reschedule':
                if (!payload.scheduledFor) return respond(400, { error: 'scheduledFor required' });
                draft.scheduledFor = payload.scheduledFor;
                break;

            case 'changeSegment':
                if (!payload.segment) return respond(400, { error: 'segment required' });
                draft.segment = payload.segment;
                break;

            default:
                return respond(400, { error: 'unknown action: ' + action });
        }

        draft.updatedAt = now;
        drafts[idx] = draft;
        file.drafts = drafts;
        file.updatedAt = now;

        await saveJsonFile('marketing_drafts.json', file, draftsRes.sha, `marketing-action: ${action} ${draftId.slice(0, 8)}`);
        return respond(200, { ok: true, draft });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
