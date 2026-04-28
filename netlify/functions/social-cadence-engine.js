// ============================================================================
// social-cadence-engine.js
//
// THE BRAIN. Reads events.json + bands + wine club, builds a 60-day promotion
// arc for everything happening at The Quarry. Idempotent — re-running won't
// create duplicates. Captions are NOT generated here (left for the hydration
// pass closer to send time). Each draft includes a "graphicBrief" telling the
// user what poster/photo to make in Canva ahead of time.
//
// POST /.netlify/functions/social-cadence-engine
// body: { mode?: 'rebuild' (rebuild from scratch) | 'incremental' (default), windowDays?: 60 }
//
// Output: writes new skeleton drafts to social_drafts.json with status='skeleton'
//
// Cadence per source type:
//   EVENT (ticketed): T-30, T-21, T-14, T-7, T-3, T-1, T-0  (7-touch arc)
//                     + adjustments based on registration fill %
//   BAND (recurring weekly): T-3 (this-weekend) + T-0 (tonight)
//   WINE CLUB: 1st Monday of each month + mid-month lifestyle post
//   ATMOSPHERE: gap-filler — only added during caption hydration if cap not hit
// ============================================================================

const fetch = require('node-fetch');
const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

// ----------------------------------------------------------------------------
// Data load/save helpers (use the data-store wrapper, same pattern as siblings)
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Time helpers — all schedule times in CT (America/Chicago)
// ----------------------------------------------------------------------------
function toCTISO(date, hourCT, minuteCT) {
    // Build an ISO string for a given local CT date at hourCT:minuteCT.
    // CT = UTC-5 (CDT) most of the year. We use offset -05:00 since the venue
    // operates within the daylight period for nearly all promo windows.
    const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
    const hh = String(hourCT || 9).padStart(2, '0'), mm = String(minuteCT || 0).padStart(2, '0');
    return `${y}-${m}-${d}T${hh}:${mm}:00-05:00`;
}
function daysFromNow(targetDateStr) {
    const t = new Date(targetDateStr + 'T12:00:00-05:00').getTime();
    return Math.round((t - Date.now()) / 86400000);
}
function dateMinusDays(targetDateStr, n) {
    const t = new Date(targetDateStr + 'T12:00:00-05:00');
    t.setDate(t.getDate() - n);
    return t;
}

// ----------------------------------------------------------------------------
// Cadence definitions — easy to tune later
// ----------------------------------------------------------------------------
const EVENT_ARC = [
    { tag: 'T-30', daysOut: 30, hourCT: 10, label: 'Save the Date' },
    { tag: 'T-21', daysOut: 21, hourCT: 11, label: 'Weekly Hype' },
    { tag: 'T-14', daysOut: 14, hourCT: 17, label: 'What to Expect' },
    { tag: 'T-7',  daysOut:  7, hourCT: 18, label: 'One Week Away' },
    { tag: 'T-3',  daysOut:  3, hourCT: 18, label: 'This Weekend' },
    { tag: 'T-1',  daysOut:  1, hourCT: 11, label: 'Tomorrow' },
    { tag: 'T-0',  daysOut:  0, hourCT:  9, label: 'Today / Tonight' },
];

const BAND_ARC = [
    { tag: 'T-3', daysOut: 3, hourCT: 17, label: 'Weekend Lineup' },
    { tag: 'T-0', daysOut: 0, hourCT: 14, label: 'Tonight' },
];

const WINE_CLUB_MONTHLY = [
    { tag: 'wc-month-open',  dayOfMonth: 1, hourCT: 10, label: 'Now Accepting Members' },
    { tag: 'wc-month-mid',   dayOfMonth: 15, hourCT: 17, label: 'Member Benefit Spotlight' },
];

// ----------------------------------------------------------------------------
// Brief generators — what graphic to make in Canva
// ----------------------------------------------------------------------------
function eventGraphicBrief(event, arcStep, fillPct) {
    const mode = fillPct >= 80 ? 'urgency' : fillPct < 30 && arcStep.daysOut <= 7 ? 'discount-push' : 'standard';
    const dateLabel = new Date(event.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
    const timeLabel = event.time ? new Date('2000-01-01T' + event.time + ':00').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';

    const calloutMap = {
        'urgency': `LAST FEW SEATS — ONLY ${Math.max(0, (event.totalCapacity || 0) - (event.registeredCount || 0))} LEFT`,
        'discount-push': `EARLY-BIRD PRICING ENDS SOON`,
        'standard': event.pricePerSeat ? `$${(event.pricePerSeat / 100).toFixed(0)} / SEAT` : 'TICKETS AVAILABLE'
    };

    return {
        type: 'event_poster',
        templateRef: `Event poster — match Boots & Bourbon / Live Bands template style`,
        neededBy: dateMinusDays(event.date, arcStep.daysOut + 2).toISOString().slice(0, 10),
        dimensions: '1080x1080 square (Instagram + Facebook safe)',
        toneMode: mode,
        spec: {
            backgroundIdea: 'Use a Quarry-relevant photographic background that matches the event theme (e.g. country/boots for Boot Scootin, bingo balls/80s for Music Bingo, vineyard for Chateau trip, etc.)',
            title: event.name.toUpperCase(),
            subtitle: event.description ? event.description.slice(0, 100) : '',
            date: dateLabel,
            time: timeLabel,
            callout: calloutMap[mode],
            footerText: 'THE QUARRY  •  EAT  •  DRINK  •  RELAX',
            qLogo: 'top-center, gold'
        },
        canvasNote: `${arcStep.label} — Post ${arcStep.daysOut} days before event. ${mode === 'discount-push' ? '(Pace warning: registration is light, lean into urgency / value.)' : mode === 'urgency' ? '(Almost sold out — high-urgency design.)' : ''}`
    };
}

function bandGraphicBrief(weekendBands, arcStep) {
    return {
        type: 'band_lineup_poster',
        templateRef: 'Match the 3-card "LIVE BANDS AT THE QUARRY" poster you already use',
        neededBy: dateMinusDays(weekendBands[0].date, arcStep.daysOut + 1).toISOString().slice(0, 10),
        dimensions: '1080x1080 square',
        toneMode: arcStep.tag === 'T-0' ? 'tonight' : 'weekend-hype',
        spec: {
            backgroundIdea: 'Quarry lake/patio at golden hour or evening string lights',
            title: arcStep.tag === 'T-0' ? 'TONIGHT — LIVE MUSIC' : 'LIVE BANDS THIS WEEKEND',
            cards: weekendBands.map((b) => ({
                day: new Date(b.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
                bandName: b.name,
                time: b.timeSlot || ''
            })),
            footerText: 'THE QUARRY  •  GREAT VIEWS  •  GREAT FOOD  •  GOOD TIMES'
        },
        canvasNote: `${arcStep.label} — covers ${weekendBands.length} band(s). Post ${arcStep.daysOut} days before first show.`
    };
}

function wineClubGraphicBrief(arcStep, monthName) {
    return {
        type: 'wine_club_poster',
        templateRef: 'Lifestyle poster — wine glass + Quarry view, "Rock & Vine" branding',
        neededBy: null,  // recurring; user can build a master template once
        dimensions: '1080x1080 square',
        toneMode: arcStep.tag === 'wc-month-open' ? 'invitation' : 'lifestyle',
        spec: {
            backgroundIdea: 'Wine glass, sunset over Quarry lake, member tasting moment',
            title: arcStep.tag === 'wc-month-open' ? 'JOIN ROCK & VINE' : 'LIFE AS A ROCK & VINE MEMBER',
            subtitle: arcStep.tag === 'wc-month-open' ? `${monthName} membership now open` : 'Curated wines • Member tastings • Exclusive events',
            callout: 'Monthly subscription — start anytime',
            footerText: 'THE QUARRY  •  ROCK & VINE WINE CLUB'
        },
        canvasNote: `${arcStep.label} — recurring monthly post for the Rock & Vine Wine Club.`
    };
}

function atmosphereBrief(theme) {
    return {
        type: 'atmosphere_photo',
        templateRef: 'No graphic needed — use a real venue photo or DALL-E generated vibe shot',
        dimensions: '1080x1080 or 1080x1350 (4:5 IG-friendly)',
        toneMode: 'vibe',
        spec: {
            backgroundIdea: theme.background,
            title: '',  // no text overlay required
            footerText: 'optional: small Q logo bottom-right'
        },
        canvasNote: theme.note
    };
}

// ----------------------------------------------------------------------------
// Helpers — group bands by weekend, generate stable IDs, etc.
// ----------------------------------------------------------------------------
function groupBandsByWeekend(bands) {
    // Group bands by their Friday-of-the-week (so Fri & Sat get one weekend post)
    const weekends = {};
    for (const b of bands) {
        const d = new Date(b.date + 'T12:00:00');
        // Find the Friday of the week containing this date
        const dow = d.getDay();  // 0=Sun, 5=Fri, 6=Sat
        const offsetToFri = ((5 - dow) + 7) % 7 - 7;  // days BACK to most recent Friday (or this Friday if today is Fri)
        const friday = new Date(d.getTime());
        friday.setDate(friday.getDate() + offsetToFri);
        if (offsetToFri > 0) friday.setDate(friday.getDate() - 7);
        const key = friday.toISOString().slice(0, 10);
        (weekends[key] = weekends[key] || []).push(b);
    }
    // Sort bands within each weekend by date
    for (const k of Object.keys(weekends)) weekends[k].sort((a, b) => a.date.localeCompare(b.date));
    return weekends;
}

function shortId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ----------------------------------------------------------------------------
// Main builder
// ----------------------------------------------------------------------------
function buildSkeletonDrafts(eventsData, existingDrafts, windowDays) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today.getTime() + windowDays * 86400000);
    const existingTags = new Set(existingDrafts.map((d) => d.cadenceTag).filter(Boolean));
    const out = [];

    // ---- Events (ticketed) ----
    const events = (eventsData.events || []).filter((e) => e.date >= today.toISOString().slice(0, 10));
    for (const event of events) {
        const fillPct = event.totalCapacity ? Math.round((event.registeredCount || 0) / event.totalCapacity * 100) : 0;
        for (const step of EVENT_ARC) {
            const postDate = dateMinusDays(event.date, step.daysOut);
            if (postDate < today || postDate > cutoff) continue;  // outside window
            const tag = `event:${event.id}:${step.tag}`;
            if (existingTags.has(tag)) continue;

            // Tone-mode skipping rules:
            // - If event is sold out (>=100%), skip T-3, T-1, T-0 (already maxed)
            if (fillPct >= 100 && ['T-3', 'T-1', 'T-0'].includes(step.tag)) continue;
            // - If it's far out and capacity is huge (200+), skip T-30 to avoid early fatigue on low-urgency
            if (event.totalCapacity >= 200 && step.tag === 'T-30' && fillPct < 5) continue;

            out.push({
                id: shortId('drf'),
                cadenceTag: tag,
                type: 'event_promo',
                platforms: ['facebook', 'instagram'],
                status: 'skeleton',
                scheduledFor: toCTISO(postDate, step.hourCT, 0),
                createdAt: new Date().toISOString(),
                createdBy: 'cadence-engine',
                context: {
                    sourceType: 'event',
                    sourceId: event.id,
                    eventName: event.name,
                    eventDate: event.date,
                    eventTime: event.time || '',
                    eventDescription: event.description || '',
                    pricePerSeat: event.pricePerSeat || 0,
                    totalCapacity: event.totalCapacity || 0,
                    registeredCount: event.registeredCount || 0,
                    fillPct,
                    arcStep: step.tag,
                    arcLabel: step.label
                },
                graphicBrief: eventGraphicBrief(event, step, fillPct),
                caption: '',
                hashtags: [],
                imageUrl: null,
                userImageUrl: null
            });
        }
    }

    // ---- Bands (group by weekend) ----
    const bands = (eventsData.bands || []).filter((b) => b.date >= today.toISOString().slice(0, 10));
    const weekends = groupBandsByWeekend(bands);
    for (const fridayKey of Object.keys(weekends).sort()) {
        const weekendBands = weekends[fridayKey];
        const firstShowDate = weekendBands[0].date;
        for (const step of BAND_ARC) {
            const postDate = dateMinusDays(firstShowDate, step.daysOut);
            if (postDate < today || postDate > cutoff) continue;
            const tag = `bands:${fridayKey}:${step.tag}`;
            if (existingTags.has(tag)) continue;
            out.push({
                id: shortId('drf'),
                cadenceTag: tag,
                type: 'band_announce',
                platforms: ['facebook', 'instagram'],
                status: 'skeleton',
                scheduledFor: toCTISO(postDate, step.hourCT, 0),
                createdAt: new Date().toISOString(),
                createdBy: 'cadence-engine',
                context: {
                    sourceType: 'band',
                    sourceId: fridayKey,
                    weekendOf: fridayKey,
                    bands: weekendBands.map((b) => ({ name: b.name, date: b.date, timeSlot: b.timeSlot || '', type: b.type || '' })),
                    arcStep: step.tag,
                    arcLabel: step.label
                },
                graphicBrief: bandGraphicBrief(weekendBands, step),
                caption: '',
                hashtags: [],
                imageUrl: null,
                userImageUrl: null
            });
        }
    }

    // ---- Wine Club (monthly recurring) ----
    for (let monthOffset = 0; monthOffset <= Math.ceil(windowDays / 30); monthOffset++) {
        const monthDate = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
        const monthName = monthDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        for (const step of WINE_CLUB_MONTHLY) {
            const postDate = new Date(monthDate.getFullYear(), monthDate.getMonth(), step.dayOfMonth);
            if (postDate < today || postDate > cutoff) continue;
            const tag = `wineclub:${postDate.toISOString().slice(0, 10)}:${step.tag}`;
            if (existingTags.has(tag)) continue;
            out.push({
                id: shortId('drf'),
                cadenceTag: tag,
                type: 'wine_club',
                platforms: ['facebook', 'instagram'],
                status: 'skeleton',
                scheduledFor: toCTISO(postDate, step.hourCT, 0),
                createdAt: new Date().toISOString(),
                createdBy: 'cadence-engine',
                context: {
                    sourceType: 'wine_club',
                    sourceId: 'rock-and-vine',
                    monthLabel: monthName,
                    arcStep: step.tag,
                    arcLabel: step.label
                },
                graphicBrief: wineClubGraphicBrief(step, monthName),
                caption: '',
                hashtags: [],
                imageUrl: null,
                userImageUrl: null
            });
        }
    }

    return out;
}

// ----------------------------------------------------------------------------
// Daily-cap reconciliation with dynamic re-prioritization.
//
// Rules:
//   - PENDING and APPROVED drafts are LOCKED (user saw them, do not auto-move).
//     They count toward the cap.
//   - SKELETON drafts can be rescheduled (push to next available day) or dropped.
//   - Higher-priority items (e.g. T-0 / T-1 / ticketed event final touches)
//     beat lower-priority items (e.g. T-30 / wine-club / atmosphere).
//   - Bumped skeletons try to slot into the next 3 days; if no room, dropped.
//
// This means: when a NEW high-priority event appears, the engine will
// automatically push or drop lower-priority skeleton drafts to make room.
// ----------------------------------------------------------------------------
function priorityScore(d) {
    const tag = (d.cadenceTag || '').toLowerCase();
    // Ticketed event arc — closer = more important
    if (/^event:/.test(tag)) {
        if (/t-0$/.test(tag)) return 100;
        if (/t-1$/.test(tag)) return 95;
        if (/t-3$/.test(tag)) return 85;
        if (/t-7$/.test(tag)) return 75;
        if (/t-14$/.test(tag)) return 65;
        if (/t-21$/.test(tag)) return 55;
        if (/t-30$/.test(tag)) return 45;
        return 50;
    }
    // Bands — core recurring content but lower than near-term ticketed events
    if (d.type === 'band_announce') {
        if (/t-0$/.test(tag)) return 80;
        return 60;
    }
    if (d.type === 'wine_club') return 30;
    if (d.type === 'atmosphere') return 20;
    return 35;
}
const isLocked = (d) => d.status === 'pending' || d.status === 'approved' || d.status === 'posted';

function applyDailyCap(allDrafts, cap) {
    // Bucket every draft by its scheduled day
    const byDay = {};
    for (const d of allDrafts) {
        if (!d.scheduledFor) continue;
        const key = d.scheduledFor.slice(0, 10);
        (byDay[key] = byDay[key] || []).push(d);
    }

    const moved = [];   // skeletons that got rescheduled
    const dropped = []; // skeletons that couldn't fit anywhere

    for (const key of Object.keys(byDay)) {
        const items = byDay[key];
        if (items.length <= cap) continue;

        // Sort: higher priority first; within same priority, locked drafts win
        items.sort((a, b) => {
            const ps = priorityScore(b) - priorityScore(a);
            if (ps !== 0) return ps;
            return (isLocked(b) ? 1 : 0) - (isLocked(a) ? 1 : 0);
        });

        // Locked drafts are kept regardless. Among the unlocked, only top N - lockedCount survive.
        const lockedCount = items.filter(isLocked).length;
        const slotsForUnlocked = Math.max(0, cap - lockedCount);

        const unlocked = items.filter((d) => !isLocked(d));
        const survivingUnlocked = unlocked.slice(0, slotsForUnlocked);
        const bumped = unlocked.slice(slotsForUnlocked);

        // Mark the new survivor list for this day
        byDay[key] = items.filter((d) => isLocked(d) || survivingUnlocked.includes(d));

        // Try to push each bumped skeleton to the next 3 days (closest first)
        for (const d of bumped) {
            let pushed = false;
            for (let n = 1; n <= 3; n++) {
                const target = new Date(d.scheduledFor);
                target.setDate(target.getDate() + n);
                const targetKey = target.toISOString().slice(0, 10);
                const targetItems = byDay[targetKey] || [];
                if (targetItems.length < cap) {
                    const oldHour = parseInt(d.scheduledFor.slice(11, 13), 10);
                    d.scheduledFor = toCTISO(target, oldHour, 0);
                    d.bumpedFromDay = d.bumpedFromDay || key;
                    targetItems.push(d);
                    byDay[targetKey] = targetItems;
                    moved.push({ id: d.id, cadenceTag: d.cadenceTag, fromDay: key, toDay: targetKey });
                    pushed = true;
                    break;
                }
            }
            if (!pushed) dropped.push(d);
        }
    }

    return {
        kept: Object.values(byDay).flat(),
        moved,
        dropped
    };
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------
exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) {}
    const windowDays = Math.min(Math.max(body.windowDays || 60, 7), 120);
    const dailyCap = body.dailyCap || 2;  // hard cap; 1/day target with 2/day burst allowed
    const dryRun = !!body.dryRun;

    try {
        const [eventsRes, draftsRes] = await Promise.all([
            loadFile('events.json'),
            loadFile('social_drafts.json'),
        ]);
        const eventsData = eventsRes.data;
        const draftsFile = draftsRes.data;
        draftsFile.drafts = Array.isArray(draftsFile.drafts) ? draftsFile.drafts : [];

        // Build new skeletons (deduped by cadenceTag — won't recreate existing ones)
        const newDrafts = buildSkeletonDrafts(eventsData, draftsFile.drafts, windowDays);
        const newCadenceTags = new Set(newDrafts.map((d) => d.cadenceTag));

        // Combined cap calc: locked drafts (pending/approved/posted) count + can't move,
        // skeletons (existing OR new) can be reshuffled. Apply across the full schedule.
        const lockedDrafts = draftsFile.drafts.filter(isLocked);
        const existingSkeletons = draftsFile.drafts.filter((d) => d.status === 'skeleton');
        const combined = [...lockedDrafts, ...existingSkeletons, ...newDrafts];
        const { kept, moved, dropped } = applyDailyCap(combined, dailyCap);

        // Determine final lists
        const finalKept = kept;
        const newKept = finalKept.filter((d) => newCadenceTags.has(d.cadenceTag));
        const droppedNewTags = new Set(dropped.filter((d) => newCadenceTags.has(d.cadenceTag)).map((d) => d.cadenceTag));

        // For dropped EXISTING skeletons (not new ones), mark them as 'superseded' rather than delete
        const supersededIds = new Set(dropped.filter((d) => !newCadenceTags.has(d.cadenceTag)).map((d) => d.id));

        if (dryRun) {
            return respond(200, {
                ok: true,
                dryRun: true,
                wouldAdd: newKept.length,
                wouldDropNew: droppedNewTags.size,
                wouldMoveExisting: moved.length,
                wouldSupersedeExisting: supersededIds.size,
                sample: newKept.slice(0, 3),
                summary: summarize(newKept)
            });
        }

        // Persist changes:
        //  - locked drafts unchanged
        //  - kept skeletons may have new scheduledFor (from `moved`)
        //  - new drafts get appended
        //  - superseded existing skeletons get marked
        const moveById = new Map(moved.map((m) => [m.id, m]));
        let mutated = false;
        for (const d of draftsFile.drafts) {
            if (d.status === 'skeleton') {
                const m = moveById.get(d.id);
                if (m) {
                    // Find the moved instance to copy its updated scheduledFor + bumpedFromDay
                    const movedInstance = finalKept.find((x) => x.id === d.id);
                    if (movedInstance) {
                        d.scheduledFor = movedInstance.scheduledFor;
                        d.bumpedFromDay = movedInstance.bumpedFromDay;
                        d.updatedAt = new Date().toISOString();
                        mutated = true;
                    }
                }
                if (supersededIds.has(d.id)) {
                    d.status = 'superseded';
                    d.supersededAt = new Date().toISOString();
                    d.supersededReason = 'Daily cap exceeded by higher-priority new event';
                    d.updatedAt = new Date().toISOString();
                    mutated = true;
                }
            }
        }
        if (newKept.length) {
            draftsFile.drafts = draftsFile.drafts.concat(newKept);
            mutated = true;
        }
        if (mutated) {
            draftsFile.updatedAt = new Date().toISOString();
            await saveFile('social_drafts.json', draftsFile, draftsRes.sha,
                `cadence-engine: +${newKept.length} new, ${moved.length} moved, ${supersededIds.size} superseded`);
        }

        return respond(200, {
            ok: true,
            added: newKept.length,
            droppedNew: droppedNewTags.size,
            movedExisting: moved.length,
            supersededExisting: supersededIds.size,
            windowDays,
            dailyCap,
            summary: summarize(newKept),
            moves: moved.slice(0, 10)
        });
    } catch (err) {
        return respond(500, { ok: false, error: err.message, stack: err.stack });
    }
};

function summarize(drafts) {
    const byType = {};
    drafts.forEach((d) => byType[d.type] = (byType[d.type] || 0) + 1);
    return byType;
}
