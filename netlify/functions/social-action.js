// ============================================================================
// social-action.js — Approve / Reject / Edit / Redo / Reschedule / Regen Image
//
// POST /.netlify/functions/social-action
// body: {
//   action: 'approve' | 'reject' | 'edit' | 'redo' | 'reschedule' | 'changePlatforms' | 'regenImage',
//   draftId: '...',
//   payload: { ...action-specific }
// }
// ============================================================================

const fetch = require('node-fetch');
const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

async function loadDrafts() {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=social_drafts.json`);
    if (!r.ok) throw new Error(`load social_drafts: ${r.status}`);
    const d = await r.json();
    return { data: d.decoded || {}, sha: d.sha };
}
async function saveDrafts(json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=social_drafts.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json, sha, message })
    });
    if (!r.ok) throw new Error(`save social_drafts: ${r.status}`);
    return r.json();
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { error: 'Invalid JSON' }); }

    const { action, draftId, payload = {} } = body;
    if (!action || !draftId) return respond(400, { error: 'action and draftId required' });

    try {
        const draftsRes = await loadDrafts();
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
                break;
            case 'reject':
                draft.status = 'rejected';
                draft.rejectedAt = now;
                draft.rejectionReason = payload.reason || '';
                break;
            case 'edit':
                if (typeof payload.caption === 'string') draft.caption = payload.caption;
                if (Array.isArray(payload.hashtags)) draft.hashtags = payload.hashtags;
                if (typeof payload.imageUrl === 'string') draft.imageUrl = payload.imageUrl;
                if (typeof payload.linkUrl === 'string') draft.linkUrl = payload.linkUrl;
                draft.status = 'pending';
                draft.approvedAt = null;
                break;
            case 'reschedule':
                if (!payload.scheduledFor) return respond(400, { error: 'scheduledFor required' });
                draft.scheduledFor = payload.scheduledFor;
                break;
            case 'changePlatforms':
                if (!Array.isArray(payload.platforms)) return respond(400, { error: 'platforms array required' });
                draft.platforms = payload.platforms;
                break;
            case 'redo': {
                const instructions = (payload.instructions || '').trim();
                if (!instructions) return respond(400, { error: 'instructions required for redo' });
                const aiResp = await fetch(`${SITE_URL}/.netlify/functions/social-ai-draft`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: draft.type,
                        platforms: draft.platforms,
                        context: draft.context || {},
                        instructions: `PREVIOUS CAPTION:\n${draft.caption}\n\nUSER FEEDBACK:\n${instructions}\n\nIMPORTANT: respond with valid JSON only — no preamble, no code fences.`
                    })
                });
                const aiBody = await aiResp.json().catch(() => ({}));
                if (!aiResp.ok || !aiBody.success) {
                    return respond(500, { error: 'AI redo failed: ' + (aiBody.error || aiResp.status) });
                }
                draft.caption = aiBody.caption;
                draft.hashtags = aiBody.hashtags || draft.hashtags;
                draft.imagePrompt = aiBody.imagePrompt || draft.imagePrompt;
                draft.regenerationCount = (draft.regenerationCount || 0) + 1;
                draft.lastInstructions = instructions;
                draft.status = 'pending';
                draft.approvedAt = null;
                break;
            }
            case 'regenImage': {
                const newPrompt = (payload.imagePrompt || draft.imagePrompt || '').trim();
                if (!newPrompt) return respond(400, { error: 'imagePrompt required (either explicitly or already on draft)' });
                const imgResp = await fetch(`${SITE_URL}/.netlify/functions/social-image-gen`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: newPrompt, draftId: draft.id })
                });
                const imgBody = await imgResp.json().catch(() => ({}));
                if (!imgResp.ok || !imgBody.success) {
                    return respond(500, { error: 'Image gen failed: ' + (imgBody.error || imgResp.status) });
                }
                draft.imageUrl = imgBody.url;
                draft.imagePrompt = newPrompt;
                draft.status = 'pending';
                draft.approvedAt = null;
                break;
            }
            default:
                return respond(400, { error: 'unknown action: ' + action });
        }

        draft.updatedAt = now;
        drafts[idx] = draft;
        file.drafts = drafts;
        file.updatedAt = now;
        await saveDrafts(file, draftsRes.sha, `social-action: ${action} ${draftId.slice(0, 8)}`);
        return respond(200, { ok: true, draft });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
