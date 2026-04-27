// ============================================================================
// social-generate-daily.js
//
// Cron-driven daily generator. For each enabled rule in social_calendar.json,
// determines which drafts should exist for today through next N days, and
// creates any that are missing. Uses social-ai-draft for copy + social-image-gen
// for hero images.
//
// Schedule: see netlify.toml. Manual trigger from admin UI also supported.
// ============================================================================

const fetch = require('node-fetch');
const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

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

function ctHourToUtcIso(localDate, hourCT) {
    const m = localDate.getUTCMonth();
    const isCDT = (m > 2 && m < 10) || (m === 2 && localDate.getUTCDate() >= 8) || (m === 10 && localDate.getUTCDate() < 1);
    const off = isCDT ? 5 : 6;
    return new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate(), hourCT + off, 0, 0)).toISOString();
}
const dateOnly = (d) => d.toISOString().slice(0, 10);

function bandTouchesForDay(rule, day, bands) {
    const out = [];
    if (!Array.isArray(bands) || !bands.length) return out;
    const offsets = (rule.schedule.offsetsDays || [0]).slice().sort((a, b) => b - a);
    for (const b of bands) {
        if (!b || !b.date) continue;
        const showDay = new Date(b.date + 'T00:00:00Z');
        for (const off of offsets) {
            const target = new Date(showDay);
            target.setUTCDate(target.getUTCDate() + off);
            if (dateOnly(target) === dateOnly(day)) {
                out.push({ band: b, offsetDays: off });
            }
        }
    }
    return out;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) {}
    const dryRun = !!body.dryRun;
    const skipImageGen = !!body.skipImageGen; // when true, drafts created without images (faster)

    const generated = [], skipped = [], errors = [];
    try {
        const [calRes, draftsRes, eventsRes, learningsRes] = await Promise.all([
            loadFile('social_calendar.json'),
            loadFile('social_drafts.json'),
            loadFile('events.json').catch(() => ({ data: { bands: [], events: [] }, sha: null })),
            loadFile('social_learnings.json').catch(() => ({ data: { learnings: [] }, sha: null })),
        ]);
        const calendar = calRes.data;
        const draftsFile = draftsRes.data;
        const settings = draftsFile.settings || {};
        const drafts = Array.isArray(draftsFile.drafts) ? draftsFile.drafts : [];
        const eventsData = eventsRes.data || {};
        const bands = Array.isArray(eventsData.bands) ? eventsData.bands : [];

        const lookAheadDays = body.lookAheadDays || (settings.generation && settings.generation.lookAheadDays) || 7;
        const maxPerDay = (settings.generation && settings.generation.maxDraftsPerDay) || 3;
        const skipExisting = (settings.generation && settings.generation.skipIfDraftExistsForRuleAndDate) !== false;

        const draftExists = (ruleId, dayKey, eventId) => drafts.some((d) =>
            d.ruleId === ruleId &&
            (!eventId || (d.context && d.context.eventId === eventId)) &&
            d.scheduledFor && d.scheduledFor.slice(0, 10) === dayKey &&
            d.status !== 'rejected'
        );

        const today = new Date(); today.setUTCHours(0, 0, 0, 0);

        for (let i = 0; i < lookAheadDays; i++) {
            const day = new Date(today);
            day.setUTCDate(day.getUTCDate() + i);
            const dayKey = dateOnly(day);
            let dayCount = drafts.filter((d) => d.scheduledFor && d.scheduledFor.slice(0, 10) === dayKey && d.status !== 'rejected').length;

            for (const rule of (calendar.rules || [])) {
                if (!rule.enabled) continue;
                if (dayCount >= maxPerDay) { skipped.push({ ruleId: rule.id, dayKey, reason: 'maxPerDay' }); continue; }

                const fires = [];
                if (rule.schedule.kind === 'weekly' && day.getUTCDay() === rule.schedule.dayOfWeek) {
                    fires.push({ scheduledFor: ctHourToUtcIso(day, rule.schedule.hourCT || 11), context: { weekOf: dayKey } });
                } else if (rule.schedule.kind === 'monthly' && day.getUTCDate() === rule.schedule.monthDay) {
                    fires.push({ scheduledFor: ctHourToUtcIso(day, rule.schedule.hourCT || 11), context: { month: day.toISOString().slice(0, 7) } });
                } else if (rule.schedule.kind === 'event_relative' && rule.type === 'band_announce') {
                    for (const t of bandTouchesForDay(rule, day, bands)) {
                        fires.push({
                            scheduledFor: ctHourToUtcIso(day, rule.schedule.hourCT || 9),
                            context: { eventId: t.band.id || t.band.name + t.band.date, band: t.band, daysUntil: -t.offsetDays },
                            eventId: t.band.id || (t.band.name + t.band.date)
                        });
                    }
                }

                for (const f of fires) {
                    if (skipExisting && draftExists(rule.id, dayKey, f.eventId)) {
                        skipped.push({ ruleId: rule.id, dayKey, reason: 'duplicate' }); continue;
                    }
                    if (dayCount >= maxPerDay) { skipped.push({ ruleId: rule.id, dayKey, reason: 'maxPerDay-mid' }); continue; }

                    if (dryRun) {
                        generated.push({ ruleId: rule.id, dayKey, dryRun: true });
                        dayCount++; continue;
                    }

                    try {
                        // Step 1: Generate caption + image prompt
                        const aiResp = await fetch(`${SITE_URL}/.netlify/functions/social-ai-draft`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                type: rule.draftType || rule.type,
                                platforms: rule.platforms || ['facebook', 'instagram'],
                                context: f.context,
                                instructions: ''
                            })
                        });
                        const ai = await aiResp.json();
                        if (!ai.success) throw new Error('AI: ' + (ai.error || 'unknown'));

                        const draftId = uuid();
                        let imageUrl = null;
                        // Step 2: Generate image (unless skipped, and only if rule expects ai_generate)
                        if (!skipImageGen && rule.imageStrategy === 'ai_generate' && ai.imagePrompt) {
                            try {
                                const imgResp = await fetch(`${SITE_URL}/.netlify/functions/social-image-gen`, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ prompt: ai.imagePrompt, draftId })
                                });
                                const img = await imgResp.json();
                                if (img.success) imageUrl = img.url;
                                else errors.push({ ruleId: rule.id, dayKey, stage: 'image', err: img.error });
                            } catch (e) { errors.push({ ruleId: rule.id, dayKey, stage: 'image', err: e.message }); }
                        } else if (rule.imageStrategy === 'venue_hero') {
                            imageUrl = 'https://thequarrystl.com/assets/img/quarry-hero-1280.jpg';
                        }

                        const draft = {
                            id: draftId,
                            ruleId: rule.id,
                            type: rule.draftType || rule.type,
                            platforms: rule.platforms || ['facebook', 'instagram'],
                            status: 'pending',
                            caption: ai.caption,
                            hashtags: ai.hashtags || [],
                            imageUrl,
                            imagePrompt: ai.imagePrompt || '',
                            linkUrl: null,
                            scheduledFor: f.scheduledFor,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            approvedAt: null, postedAt: null,
                            fbPostId: null, igMediaId: null,
                            regenerationCount: 0, lastInstructions: '',
                            context: f.context,
                            model: ai.model || 'claude'
                        };
                        drafts.push(draft);
                        generated.push({ id: draftId, ruleId: rule.id, scheduledFor: draft.scheduledFor, caption: draft.caption.slice(0, 80) });
                        dayCount++;
                    } catch (err) {
                        errors.push({ ruleId: rule.id, dayKey, error: err.message });
                    }
                }
            }
        }

        if (!dryRun && generated.length) {
            draftsFile.drafts = drafts;
            draftsFile.updatedAt = new Date().toISOString();
            await saveFile('social_drafts.json', draftsFile, draftsRes.sha,
                `social-generate: ${generated.length} draft(s)`);
        }

        return respond(200, { ok: true, dryRun, generatedCount: generated.length, skippedCount: skipped.length, generated, skipped: skipped.slice(0, 20), errors });
    } catch (err) {
        return respond(500, { ok: false, error: err.message, generated, errors });
    }
};
