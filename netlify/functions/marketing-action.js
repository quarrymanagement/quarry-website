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

function stripOuterWrappers(html) {
    if (!html) return '';
    let s = String(html).trim();
    const m = s.match(/^<div[^>]*>([\s\S]*)<\/div>\s*$/i);
    if (m && /background|font-family|max-width|padding\s*:/i.test(s.slice(0, s.indexOf('>') + 1))) s = m[1].trim();
    s = s.replace(/<\/?(html|body|head)[^>]*>/gi, '').replace(/<!doctype[^>]*>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    return s.trim();
}

function wrapWithFooter(htmlBody) {
    const LOGO_URL  = 'https://thequarrystl.com/assets/quarry-q-logo.png';
    const HERO_URL  = 'https://thequarrystl.com/assets/img/quarry-hero-1280.jpg';
    const WEB_URL   = 'https://www.thequarrystl.com';
    const FB_URL    = 'https://www.facebook.com/thequarrystl';
    const IG_URL    = 'https://www.instagram.com/thequarrystl';
    const UNSUB_URL = 'https://www.thequarrystl.com/.netlify/functions/unsubscribe?email={email}';
    const RES_URL   = 'https://www.thequarrystl.com/quarry-private-events.html?utm_source=email&utm_medium=marketing&utm_campaign=footer-cta';
    const NAVY     = '#1a2942';
    const NAVY_DK  = '#0f1a2e';
    const CREAM    = '#f5efde';
    const GOLD     = '#9a7b2a';
    const GOLD_LT  = '#c9a44a';
    const TEXT     = '#2c2c2c';
    const MUTED    = '#6b6b6b';
    const CREAM_ON_NAVY = '#f3ecd9';

    htmlBody = stripOuterWrappers(htmlBody);

    // Text-based "Follow us:" — more reliable across email clients than icons.

    const bodyStyles = `<style>.qbody{font-family:'Helvetica Neue',Arial,sans-serif;color:${TEXT};line-height:1.65;}.qbody h1{font-family:'Playfair Display',Georgia,serif;color:${NAVY};font-size:28px;line-height:1.25;margin:0 0 18px;font-weight:700;}.qbody h2{font-family:'Playfair Display',Georgia,serif;color:${NAVY};font-size:22px;line-height:1.3;margin:28px 0 14px;font-weight:700;}.qbody h3{font-family:'Helvetica Neue',Arial,sans-serif;color:${GOLD};font-size:12px;line-height:1.3;margin:24px 0 8px;text-transform:uppercase;letter-spacing:0.16em;font-weight:700;}.qbody p{font-size:16px;line-height:1.7;color:${TEXT};margin:0 0 16px;}.qbody ul,.qbody ol{margin:0 0 16px 18px;padding:0;font-size:16px;line-height:1.7;}.qbody li{margin:0 0 8px;}.qbody a{color:${GOLD};text-decoration:underline;}.qbody hr{border:0;border-top:1px solid #d4ccb3;margin:24px 0;}.qbody .event-card{background:rgba(255,255,255,0.6);border-left:4px solid ${GOLD};padding:14px 16px;margin:0 0 14px;border-radius:4px;}.qbody .event-date{font-size:12px;color:${GOLD};font-weight:700;text-transform:uppercase;letter-spacing:0.12em;margin:0 0 4px;}.qbody .event-title{font-family:'Playfair Display',Georgia,serif;font-size:18px;color:${NAVY};font-weight:700;margin:0 0 4px;}.qbody .event-meta{font-size:13px;color:${MUTED};margin:0;}</style>`;

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><meta name="format-detection" content="telephone=no"><title>The Quarry</title>${bodyStyles}</head>
<body style="margin:0;padding:0;background:${NAVY};-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${NAVY};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${CREAM};border-radius:8px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
<tr><td align="center" style="background:${NAVY};padding:24px 24px 18px;">
<a href="${WEB_URL}" style="text-decoration:none;display:inline-block;"><img src="${LOGO_URL}" alt="The Quarry" width="64" height="64" style="display:block;margin:0 auto 8px;border:0;outline:none;"></a>
<div style="font-family:'Playfair Display',Georgia,serif;font-size:24px;color:${CREAM_ON_NAVY};letter-spacing:0.14em;font-weight:700;line-height:1;">THE QUARRY</div>
<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;color:${GOLD_LT};letter-spacing:0.22em;text-transform:uppercase;margin-top:10px;font-weight:600;">
<a href="https://www.thequarrystl.com/quarry-drinks.html?utm_source=email&utm_medium=marketing&utm_campaign=header-tagline&utm_content=drinks" style="color:${GOLD_LT};text-decoration:none;">Drinks</a> &nbsp;·&nbsp;
<a href="https://www.thequarrystl.com/quarry-menu.html?utm_source=email&utm_medium=marketing&utm_campaign=header-tagline&utm_content=bites" style="color:${GOLD_LT};text-decoration:none;">Bites</a> &nbsp;·&nbsp;
<a href="https://www.thequarrystl.com/quarry-bands.html?utm_source=email&utm_medium=marketing&utm_campaign=header-tagline&utm_content=music" style="color:${GOLD_LT};text-decoration:none;">Live Music</a> &nbsp;·&nbsp;
<a href="https://www.thequarrystl.com/quarry-golf.html?utm_source=email&utm_medium=marketing&utm_campaign=header-tagline&utm_content=golf" style="color:${GOLD_LT};text-decoration:none;">Golf</a>
</div></td></tr>
<tr><td style="padding:0;line-height:0;font-size:0;"><a href="${WEB_URL}" style="display:block;"><img src="${HERO_URL}" alt="The Quarry" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;"></a></td></tr>
<tr><td class="qbody" style="background:${CREAM};padding:32px 32px 16px;">${htmlBody}</td></tr>
<tr><td align="center" style="background:${CREAM};padding:8px 32px 32px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${GOLD}" style="border-radius:6px;box-shadow:0 4px 12px rgba(154,123,42,0.35);"><a href="${RES_URL}" style="display:inline-block;padding:16px 36px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#ffffff;text-decoration:none;border-radius:6px;">Book Your Next Event &nbsp;→</a></td></tr></table>
<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:${MUTED};margin-top:14px;letter-spacing:0.04em;">Wed–Sun &nbsp;·&nbsp; New Melle, MO &nbsp;·&nbsp; <a href="tel:6362248257" style="color:${GOLD};text-decoration:none;">(636) 224-8257</a></div></td></tr>
<tr><td align="center" style="background:${NAVY_DK};padding:24px 24px 22px;">
<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:${CREAM_ON_NAVY};letter-spacing:0.08em;text-transform:uppercase;font-weight:600;margin-bottom:14px;">Follow us: &nbsp; <a href="${FB_URL}" style="color:${GOLD_LT};text-decoration:none;font-weight:600;">Facebook</a> &nbsp;·&nbsp; <a href="${IG_URL}" style="color:${GOLD_LT};text-decoration:none;font-weight:600;">Instagram</a> &nbsp;·&nbsp; <a href="${WEB_URL}" style="color:${GOLD_LT};text-decoration:none;font-weight:600;">Website</a></div>
<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:${CREAM_ON_NAVY};line-height:1.5;margin-bottom:8px;"><strong style="color:${GOLD_LT};">The Quarry</strong> &nbsp;·&nbsp; 3960 Highway Z &nbsp;·&nbsp; New Melle, MO 63385 &nbsp;·&nbsp; (636) 224-8257</div>
<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:rgba(243,236,217,0.55);line-height:1.6;">You're receiving this because you signed up, booked an event, or attended one at The Quarry.<br><a href="${UNSUB_URL}" style="color:rgba(243,236,217,0.75);text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp; <a href="https://www.thequarrystl.com/privacy.html" style="color:rgba(243,236,217,0.75);text-decoration:underline;">Privacy Policy</a></div>
</td></tr></table>
<div style="font-family:'Playfair Display',Georgia,serif;color:rgba(243,236,217,0.30);font-size:11px;letter-spacing:0.18em;margin-top:18px;">— THE QUARRY —</div>
</td></tr></table></body></html>`;
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
