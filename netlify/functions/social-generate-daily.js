// ============================================================================
// social-generate-daily.js
//
// Cron-driven daily orchestrator (was: rules engine; now: pipeline runner).
//
// PIPELINE:
//   1. Run social-cadence-engine — adds skeleton drafts for any new
//      events/bands/wine club entries within the 60-day window.
//   2. Hydrate captions — for any skeleton drafts scheduled in the next
//      `hydrateDays` (default 7), call social-ai-draft to generate caption +
//      hashtags + imagePrompt. Mark them 'pending' so the user reviews them.
//   3. Image strategy: caption-only by default (user uploads their own poster
//      from Canva). Pass `genImages: true` to force DALL-E hero gen, or
//      include atmosphere posts where AI imagery is appropriate.
//
// Cron schedule: see netlify.toml (currently 13:00 UTC = 8am CT).
// Manual trigger: from Social tab "Generate Drafts Now" button.
// ============================================================================

const fetch = require('node-fetch');
const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

async function loadFile(file) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`);
    if (!r.ok) throw new Error(`load ${file}: ${r.status}`);
    const d = await r.json();
    return { data: d.decoded || {}, sha: d.sha };
}
async function saveFile(file, json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json, sha, message })
    });
    if (!r.ok) throw new Error(`save ${file}: ${r.status}`);
    return r.json();
}

async function runCadenceEngine(windowDays) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/social-cadence-engine`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowDays, dailyCap: 2 })
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`cadence-engine failed: ${body.error || r.status}`);
    return body;
}

async function hydrateCaption(draft) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/social-ai-draft`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: draft.type,
            platforms: draft.platforms,
            context: draft.context || {},
            instructions: ''
        })
    });
    const body = await r.json();
    if (!body.success) throw new Error('AI: ' + (body.error || 'unknown'));
    return body;
}

async function generateImageForDraft(draft, ai) {
    if (!ai.imagePrompt) return null;
    try {
        const r = await fetch(`${SITE_URL}/.netlify/functions/social-image-gen`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: ai.imagePrompt, draftId: draft.id })
        });
        const body = await r.json();
        if (body.success) return body.url;
    } catch (_) {}
    return null;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) {}
    const dryRun = !!body.dryRun;
    const windowDays = body.windowDays || 60;
    const hydrateDays = body.hydrateDays || 7;
    // imageMode: 'none' (user uploads), 'atmosphere' (only for atmosphere drafts), 'all' (every draft)
    const imageMode = body.imageMode || 'atmosphere';

    const result = { ok: true, cadence: null, hydrated: [], errors: [] };

    try {
        // ---- Step 1: build any new skeleton drafts ----
        result.cadence = await runCadenceEngine(windowDays);

        // ---- Step 2: hydrate captions for skeletons coming up in next hydrateDays ----
        const draftsRes = await loadFile('social_drafts.json');
        const draftsFile = draftsRes.data;
        draftsFile.drafts = Array.isArray(draftsFile.drafts) ? draftsFile.drafts : [];

        const now = Date.now();
        const cutoff = now + hydrateDays * 86400000;
        const toHydrate = draftsFile.drafts.filter((d) =>
            d.status === 'skeleton' &&
            d.scheduledFor &&
            new Date(d.scheduledFor).getTime() <= cutoff
        ).sort((a, b) => (a.scheduledFor || '').localeCompare(b.scheduledFor || ''));

        if (dryRun) {
            return respond(200, {
                ok: true, dryRun: true,
                cadence: result.cadence,
                wouldHydrate: toHydrate.length,
                sample: toHydrate.slice(0, 3).map((d) => ({ id: d.id, type: d.type, scheduledFor: d.scheduledFor, cadenceTag: d.cadenceTag }))
            });
        }

        let mutated = false;
        for (const draft of toHydrate) {
            try {
                const ai = await hydrateCaption(draft);
                draft.caption = ai.caption;
                draft.hashtags = ai.hashtags || [];
                draft.imagePrompt = ai.imagePrompt || '';
                draft.variants = ai.variants || null;
                draft.suggestedTimeHourCT = ai.suggestedTimeHourCT;
                draft.aiReasoning = ai.reasoning || '';
                draft.model = ai.model || 'claude';
                draft.hydratedAt = new Date().toISOString();
                draft.status = 'pending';

                // Update graphic brief with reelBrief if AI suggested one
                if (ai.reelBrief && draft.graphicBrief) {
                    draft.graphicBrief.reelBrief = ai.reelBrief;
                }

                // Image strategy:
                // 1. If user already uploaded their own image, leave it.
                // 2. If AI picked an asset from the library, use that URL (FREE, no DALL-E).
                // 3. Else if imageMode says we should DALL-E for this post type, do it.
                if (!draft.userImageUrl && !draft.imageUrl) {
                    if (ai.selectedAssetUrl) {
                        draft.imageUrl = ai.selectedAssetUrl;
                        draft.imageSource = 'library';
                        draft.selectedAssetId = ai.selectedAssetId;
                    } else {
                        const wantImage =
                            imageMode === 'all' ||
                            (imageMode === 'atmosphere' && draft.type === 'atmosphere');
                        if (wantImage) {
                            const url = await generateImageForDraft(draft, ai);
                            if (url) { draft.imageUrl = url; draft.imageSource = 'dalle'; }
                        }
                    }
                }

                draft.updatedAt = new Date().toISOString();
                result.hydrated.push({ id: draft.id, type: draft.type, scheduledFor: draft.scheduledFor, captionPreview: (draft.caption || '').slice(0, 80), imageSource: draft.imageSource || 'none' });
                mutated = true;
            } catch (err) {
                result.errors.push({ id: draft.id, error: err.message });
            }
        }

        if (mutated) {
            draftsFile.updatedAt = new Date().toISOString();
            await saveFile('social_drafts.json', draftsFile, draftsRes.sha,
                `social-generate: cadence +${result.cadence.added || 0}, hydrated ${result.hydrated.length}`);
        }

        result.generatedCount = result.hydrated.length;  // for back-compat with admin UI
        return respond(200, result);
    } catch (err) {
        return respond(500, { ok: false, error: err.message, partial: result });
    }
};
