// Netlify Scheduled Function — runs daily at 12:00 UTC (~7 AM CT in CDT, 6 AM in CST)
// Tag at top so the new Netlify scheduler picks it up without netlify.toml.

// ============================================================================
// marketing-generate-daily.js
//
// Cron-style endpoint. Runs once a day (Netlify Scheduled Function or external
// scheduler hits this URL). For the next N days (default 7), walks every
// enabled rule in marketing_calendar.json, computes whether a draft should
// exist for that rule on that day, and if so generates one via ai-draft.js
// and appends it to marketing_drafts.json with status='pending'.
//
// Idempotent: if a pending/approved/sent draft already exists for the same
// (ruleId, scheduledFor) pair, it is skipped (controlled by
// settings.generation.skipIfDraftExistsForRuleAndDate).
//
// POST /.netlify/functions/marketing-generate-daily
//      headers: x-quarry-key: <QUARRY_DATA_KEY>
//      body (optional): { dryRun: bool, lookAheadDays: number, force: bool }
//
// Response: { generated: [{id, ruleId, scheduledFor, subject}], skipped: N, errors: [...] }
// ============================================================================

const https = require('https');
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

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function uuid() {
    // RFC4122 v4-ish — collision-safe enough for our scale
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

async function loadJsonFile(file) {
    const resp = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`);
    if (!resp.ok) throw new Error(`Failed to load ${file}: ${resp.status}`);
    const data = await resp.json();
    return { data: data.decoded || {}, sha: data.sha };
}

async function saveJsonFile(file, json, sha, message) {
    const resp = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-quarry-key': QUARRY_DATA_KEY },
        body: JSON.stringify({ json, sha, message })
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Failed to save ${file}: ${resp.status} ${text.slice(0, 200)}`);
    }
    return await resp.json();
}

// Convert America/Chicago hour-of-day to UTC ISO for a given local date.
// Naive but stable for our use: we always send "around" the hour, and the
// scheduler runs every 5 min so a few minutes of drift is fine.
function ctHourToUtcIso(localDate, hourCT) {
    // CT is UTC-6 (CST) or UTC-5 (CDT). DST in US runs ~Mar second Sunday → Nov first Sunday.
    const m = localDate.getUTCMonth(); // 0=Jan
    const isCDT = (m > 2 && m < 10) || (m === 2 && localDate.getUTCDate() >= 8) || (m === 10 && localDate.getUTCDate() < 1);
    const offsetH = isCDT ? 5 : 6;
    return new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate(), hourCT + offsetH, 0, 0)).toISOString();
}

function dateOnly(d) { return d.toISOString().slice(0, 10); }

function shouldFireWeekly(rule, day) {
    return day.getUTCDay() === rule.schedule.dayOfWeek;
}
function shouldFireMonthly(rule, day) {
    return day.getUTCDate() === rule.schedule.monthDay;
}

// Discover which event(s) need a touch on `day` based on event_relative offsets
function eventTouchesForDay(rule, day, events) {
    const touches = [];
    if (!Array.isArray(events)) return touches;
    const offsets = (rule.schedule.offsetsDays || []).slice().sort((a, b) => b - a); // -2 fires last
    for (const ev of events) {
        if (!ev.date) continue;
        const eventDay = new Date(ev.date + 'T00:00:00Z');
        for (const off of offsets) {
            const target = new Date(eventDay);
            target.setUTCDate(target.getUTCDate() + off);
            if (dateOnly(target) === dateOnly(day)) {
                const typeMap = { '-30': 'event_promo_30d', '-14': 'event_promo_14d', '-7': 'event_promo_7d', '-2': 'event_promo_2d', '0': 'event_promo_2d' };
                touches.push({ event: ev, draftType: typeMap[String(off)] || 'event_promo_7d', offsetDays: off });
            }
        }
    }
    return touches;
}

// Call ai-draft.js function (in-process via a sub-request)
async function generateDraft(type, context, instructions, learnings) {
    // Inject learnings as additional instructions so the AI considers them
    let aug = instructions || '';
    if (Array.isArray(learnings) && learnings.length) {
        const top = learnings.filter((l) => !l.supersededAt).slice(0, 6).map((l) => `- ${l.insight}`).join('\n');
        if (top) aug = `OPTIMIZATION INSIGHTS (apply these):\n${top}\n\n${aug}`.trim();
    }
    const resp = await fetch(`${SITE_URL}/.netlify/functions/ai-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, context, instructions: aug, model: 'claude' })
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`ai-draft failed: ${resp.status} ${text.slice(0, 300)}`);
    }
    return await resp.json();
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

// Schedule: see netlify.toml. Manual trigger from the admin UI also works.
exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
        return respond(405, { error: 'Use POST (or GET for cron triggers).' });
    }

    // Auth: scheduled invocations come from Netlify internally and have
    // a body shaped like {"next_run":"..."} — we trust those. Otherwise
    // require x-quarry-key when QUARRY_DATA_KEY is set.
    const isScheduled = (event.body && /"next_run"/.test(event.body)) ||
                        (event.headers && /netlify/i.test(event.headers['user-agent'] || ''));
    if (!isScheduled && QUARRY_DATA_KEY) {
        const provided = event.headers['x-quarry-key'] || event.headers['X-Quarry-Key'] || '';
        if (provided !== QUARRY_DATA_KEY) {
            return respond(401, { error: 'Missing or invalid x-quarry-key header' });
        }
    }

    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) {}
    const dryRun = !!body.dryRun;

    const generated = [];
    const skipped = [];
    const errors = [];

    try {
        // 1. Load all data files in parallel
        const [calendarRes, draftsRes, eventsRes, learningsRes] = await Promise.all([
            loadJsonFile('marketing_calendar.json'),
            loadJsonFile('marketing_drafts.json'),
            loadJsonFile('events.json').catch(() => ({ data: { events: [] }, sha: null })),
            loadJsonFile('marketing_learnings.json').catch(() => ({ data: { learnings: [] }, sha: null }))
        ]);

        const calendar = calendarRes.data;
        const draftsFile = draftsRes.data;
        const events = (eventsRes.data && (eventsRes.data.events || eventsRes.data)) || [];
        const learnings = (learningsRes.data && learningsRes.data.learnings) || [];

        const settings = draftsFile.settings || {};
        const lookAheadDays = body.lookAheadDays || (settings.generation && settings.generation.lookAheadDays) || 7;
        const skipIfExists = (settings.generation && settings.generation.skipIfDraftExistsForRuleAndDate) !== false;
        const maxPerDay = (settings.generation && settings.generation.maxDraftsPerDay) || 4;
        const drafts = Array.isArray(draftsFile.drafts) ? draftsFile.drafts : [];

        // Helper: is there already a non-rejected draft for (ruleId, dayKey)?
        const draftExists = (ruleId, dayKey, eventId) => drafts.some((d) =>
            d.ruleId === ruleId &&
            (!eventId || (d.context && d.context.eventId === eventId)) &&
            d.scheduledFor && d.scheduledFor.slice(0, 10) === dayKey &&
            d.status !== 'rejected'
        );

        // 2. Walk the next N days
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);

        for (let i = 0; i < lookAheadDays; i++) {
            const day = new Date(today);
            day.setUTCDate(day.getUTCDate() + i);
            const dayKey = dateOnly(day);
            let dayCount = drafts.filter((d) => d.scheduledFor && d.scheduledFor.slice(0, 10) === dayKey && d.status !== 'rejected').length;

            for (const rule of (calendar.rules || [])) {
                if (!rule.enabled) continue;
                if (dayCount >= maxPerDay) {
                    skipped.push({ ruleId: rule.id, dayKey, reason: 'maxPerDay reached' });
                    continue;
                }

                // Resolve send time + draft type + context per rule kind
                const fires = []; // [{draftType, scheduledFor, context, eventId?}]

                if (rule.schedule.kind === 'weekly' && shouldFireWeekly(rule, day)) {
                    const upcomingWeek = events.filter((e) => {
                        const ed = new Date(e.date + 'T00:00:00Z');
                        const diff = (ed - day) / (1000 * 60 * 60 * 24);
                        return diff >= 0 && diff <= 7;
                    });
                    fires.push({
                        draftType: rule.draftType,
                        scheduledFor: ctHourToUtcIso(day, rule.schedule.hourCT || 10),
                        context: { weekOf: dayKey, events: upcomingWeek.slice(0, 8) }
                    });
                } else if (rule.schedule.kind === 'monthly' && shouldFireMonthly(rule, day)) {
                    fires.push({
                        draftType: rule.draftType,
                        scheduledFor: ctHourToUtcIso(day, rule.schedule.hourCT || 11),
                        context: { month: day.toISOString().slice(0, 7) }
                    });
                } else if (rule.schedule.kind === 'event_relative') {
                    for (const t of eventTouchesForDay(rule, day, events)) {
                        fires.push({
                            draftType: t.draftType,
                            scheduledFor: ctHourToUtcIso(day, rule.schedule.hourCT || 10),
                            context: { eventId: t.event.id, event: t.event, daysUntil: -t.offsetDays },
                            eventId: t.event.id
                        });
                    }
                }
                // (one_off and trigger kinds intentionally not auto-fired here — those are handled
                // by separate trigger functions or manual scheduling.)

                for (const f of fires) {
                    if (skipIfExists && draftExists(rule.id, dayKey, f.eventId)) {
                        skipped.push({ ruleId: rule.id, dayKey, reason: 'duplicate' });
                        continue;
                    }
                    if (dayCount >= maxPerDay) {
                        skipped.push({ ruleId: rule.id, dayKey, reason: 'maxPerDay reached mid-loop' });
                        continue;
                    }

                    if (dryRun) {
                        generated.push({ ruleId: rule.id, draftType: f.draftType, scheduledFor: f.scheduledFor, dryRun: true });
                        dayCount++;
                        continue;
                    }

                    try {
                        const ai = await generateDraft(f.draftType, f.context, '', learnings);
                        if (!ai || !ai.success) throw new Error('ai-draft returned non-success: ' + JSON.stringify(ai).slice(0, 200));
                        const draft = {
                            id: uuid(),
                            ruleId: rule.id,
                            type: f.draftType,
                            status: 'pending',
                            subject: ai.subject,
                            htmlBody: ai.htmlBody,
                            innerHtml: ai.innerHtml || '',
                            segment: ai.suggestedRecipientFilter || rule.segment || 'Subscribed',
                            scheduledFor: f.scheduledFor,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            approvedAt: null,
                            approvedBy: null,
                            rejectedAt: null,
                            rejectionReason: null,
                            sentAt: null,
                            sgMessageId: null,
                            regenerationCount: 0,
                            lastInstructions: '',
                            context: f.context,
                            model: ai.model || 'claude'
                        };
                        drafts.push(draft);
                        generated.push({ id: draft.id, ruleId: rule.id, scheduledFor: draft.scheduledFor, subject: draft.subject });
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
            await saveJsonFile('marketing_drafts.json', draftsFile, draftsRes.sha,
                `auto-generate ${generated.length} draft(s) — ${new Date().toISOString().slice(0, 10)}`);
        }

        return respond(200, {
            ok: true,
            dryRun,
            generated,
            generatedCount: generated.length,
            skippedCount: skipped.length,
            skipped: skipped.slice(0, 20),
            errors
        });
    } catch (err) {
        return respond(500, { ok: false, error: err.message, generated, errors });
    }
};
