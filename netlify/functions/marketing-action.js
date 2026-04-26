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
    const footer = `
<div style="max-width:600px;margin:2rem auto 0;padding:1.5rem 1rem;border-top:1px solid #e0e3e8;font-family:'Montserrat',-apple-system,sans-serif;font-size:0.75rem;color:#858d9e;text-align:center;line-height:1.5;">
  <div style="margin-bottom:0.5rem;">
    <strong style="color:#4b5263;">The Quarry</strong> &middot; 3960 Highway Z, New Melle, MO 63385
  </div>
  <div style="margin-bottom:0.5rem;">
    <a href="https://www.thequarrystl.com" style="color:#9a7b2a;text-decoration:none;">thequarrystl.com</a> &middot;
    <a href="https://www.facebook.com/thequarrystl" style="color:#9a7b2a;text-decoration:none;">Facebook</a>
  </div>
  <div>
    You're receiving this because you signed up, booked a reservation, or attended an event at The Quarry.
    <a href="https://www.thequarrystl.com/unsubscribe?email={email}" style="color:#858d9e;text-decoration:underline;">Unsubscribe</a>
  </div>
</div>`;
    return `<div style="background:#f4f5f7;padding:2rem 1rem;font-family:'Montserrat',-apple-system,BlinkMacSystemFont,sans-serif;color:#1c1f26;line-height:1.6;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:2rem 1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
<div style="text-align:center;margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:2px solid #9a7b2a;">
  <div style="font-family:'Playfair Display',Georgia,serif;font-size:1.8rem;color:#1c1f26;letter-spacing:0.02em;">THE QUARRY</div>
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
                const aiResp = await fetch(`${SITE_URL}/.netlify/functions/ai-draft`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: payload.type || draft.type,
                        context: draft.context || {},
                        instructions: `PREVIOUS SUBJECT: ${draft.subject}\nPREVIOUS BODY (excerpt): ${(draft.innerHtml || '').slice(0, 800)}\n\nUSER FEEDBACK FOR REVISION:\n${instructions}`,
                        model: 'claude'
                    })
                });
                if (!aiResp.ok) {
                    const t = await aiResp.text();
                    return respond(500, { error: 'ai-draft failed: ' + t.slice(0, 300) });
                }
                const ai = await aiResp.json();
                if (!ai.success) return respond(500, { error: 'ai-draft non-success', ai });
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
