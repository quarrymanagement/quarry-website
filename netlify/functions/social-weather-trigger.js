// ============================================================================
// social-weather-trigger.js
//
// Reads today's weather forecast for The Quarry's lat/lon. If it's "patio
// perfect" (65-85°F, low precip chance, daytime hours), creates a patio
// atmosphere skeleton draft. If it's stormy on a service day, creates a
// "cozy fireside" draft instead.
//
// Idempotent — uses cadenceTag like `weather:2026-05-02:patio` so re-runs
// won't duplicate. Service days are Wed-Sun (Mon/Tue closed).
//
// Free weather data from Open-Meteo (no API key required).
// Cron: 12:00 UTC = 7am CT, runs daily.
// ============================================================================

const fetch = require('node-fetch');
const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';

// The Quarry, 3960 Highway Z, New Melle MO 63385
const LAT = 38.7159;
const LON = -90.7997;
const TZ  = 'America/Chicago';

// Service days (0=Sun, 1=Mon, ..., 6=Sat). Wed-Sun = open.
const SERVICE_DAYS = new Set([0, 3, 4, 5, 6]);

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

async function fetchForecast() {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
        `&hourly=temperature_2m,precipitation_probability,weather_code` +
        `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(TZ)}&forecast_days=2`;
    const r = await fetch(url, { timeout: 15000 });
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
    return r.json();
}

function classifyDay(forecast, dayOffset) {
    // Look at the 11am-9pm CT window for today (or +1 for tomorrow)
    const hourly = forecast.hourly || {};
    const times = hourly.time || [];
    const temps = hourly.temperature_2m || [];
    const precs = hourly.precipitation_probability || [];

    // Compute target day in CT, not UTC. Open-Meteo returns hourly slots
    // already in our requested timezone; we need to match against the same
    // calendar day The Quarry sees, not whatever day the UTC server is on.
    const targetDay = new Date();
    targetDay.setDate(targetDay.getDate() + dayOffset);
    const targetKey = targetDay.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    let temps11to21 = [], precs11to21 = [];
    for (let i = 0; i < times.length; i++) {
        const t = times[i];
        if (!t.startsWith(targetKey)) continue;
        const hour = parseInt(t.slice(11, 13), 10);
        if (hour < 11 || hour > 21) continue;
        temps11to21.push(temps[i]);
        precs11to21.push(precs[i] || 0);
    }
    if (!temps11to21.length) return { mode: null, dayKey: targetKey };

    const minT = Math.min(...temps11to21);
    const maxT = Math.max(...temps11to21);
    const maxP = Math.max(...precs11to21);

    // Patio-perfect: 65-85°F window, max precip prob < 25%
    if (minT >= 62 && maxT <= 88 && maxP < 25) {
        return { mode: 'patio', dayKey: targetKey, minT, maxT, maxP };
    }
    // Stormy: high precip prob OR temps very cold
    if (maxP >= 60 || maxT < 50) {
        return { mode: 'cozy', dayKey: targetKey, minT, maxT, maxP };
    }
    return { mode: null, dayKey: targetKey, minT, maxT, maxP };
}

function patioBrief(maxT) {
    return {
        type: 'atmosphere_photo',
        templateRef: 'No graphic needed — ideally a real venue patio shot from the asset library',
        dimensions: '1080x1080 or 1080x1350 (4:5)',
        toneMode: 'patio-perfect',
        spec: {
            backgroundIdea: `Beautiful Quarry patio at golden hour — empty table, string lights, lake/cliff in soft focus. ${maxT}°F today.`,
            title: '',
            footerText: 'optional small Q logo bottom-right'
        },
        canvasNote: `Patio-perfect day (${maxT}°F). Caption hooks on the weather.`
    };
}
function cozyBrief() {
    return {
        type: 'atmosphere_photo',
        templateRef: 'No graphic needed — interior fireplace / cozy bar / warm food shot',
        dimensions: '1080x1080 or 1080x1350 (4:5)',
        toneMode: 'cozy-indoors',
        spec: {
            backgroundIdea: 'Warm interior — fireplace, candles on the bar, glass of red wine in foreground, soft ambient light',
            title: '',
            footerText: 'optional small Q logo bottom-right'
        },
        canvasNote: 'Stormy / cold day. Lean into "perfect day to come in and warm up" vibes.'
    };
}

let _idCounter = 0;
function shortId(prefix) { _idCounter++; return `${prefix}-${Date.now().toString(36)}-${_idCounter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (_) {}
    const dryRun = !!body.dryRun;

    try {
        const forecast = await fetchForecast();

        // Classify today and tomorrow
        const candidates = [];
        for (const offset of [0, 1]) {
            const c = classifyDay(forecast, offset);
            if (!c.mode) continue;
            // Only generate for service days (Wed-Sun)
            const checkDate = new Date(c.dayKey + 'T12:00:00-05:00');
            if (!SERVICE_DAYS.has(checkDate.getDay())) continue;
            candidates.push(c);
        }

        if (!candidates.length) {
            return respond(200, { ok: true, message: 'No weather-driven posts triggered today.', forecast: { todayClass: classifyDay(forecast, 0), tomorrowClass: classifyDay(forecast, 1) } });
        }

        const draftsRes = await loadFile('social_drafts.json');
        const draftsFile = draftsRes.data;
        draftsFile.drafts = Array.isArray(draftsFile.drafts) ? draftsFile.drafts : [];
        const existingTags = new Set(draftsFile.drafts.map((d) => d.cadenceTag).filter(Boolean));

        const newDrafts = [];
        for (const c of candidates) {
            const tag = `weather:${c.dayKey}:${c.mode}`;
            if (existingTags.has(tag)) continue;

            // Schedule: post at 11am CT on the target day (well before lunch traffic)
            const scheduled = new Date(c.dayKey + 'T11:00:00-05:00').toISOString();

            newDrafts.push({
                id: shortId('drf'),
                cadenceTag: tag,
                type: 'atmosphere',
                platforms: ['facebook', 'instagram'],
                status: 'skeleton',
                scheduledFor: scheduled,
                createdAt: new Date().toISOString(),
                createdBy: 'weather-trigger',
                context: {
                    sourceType: 'weather',
                    sourceId: c.dayKey,
                    weatherMode: c.mode,
                    temperatureRange: c.minT && c.maxT ? `${Math.round(c.minT)}-${Math.round(c.maxT)}°F` : null,
                    maxPrecipChance: c.maxP,
                    arcLabel: c.mode === 'patio' ? 'Patio-perfect day' : 'Cozy weather'
                },
                graphicBrief: c.mode === 'patio' ? patioBrief(Math.round(c.maxT)) : cozyBrief(),
                caption: '', hashtags: [], imageUrl: null, userImageUrl: null
            });
        }

        if (dryRun) return respond(200, { ok: true, dryRun: true, candidates, wouldAdd: newDrafts.length, sample: newDrafts.slice(0, 2) });
        if (!newDrafts.length) return respond(200, { ok: true, message: 'Weather drafts already exist for today/tomorrow.' });

        draftsFile.drafts = draftsFile.drafts.concat(newDrafts);
        draftsFile.updatedAt = new Date().toISOString();
        await saveFile('social_drafts.json', draftsFile, draftsRes.sha,
            `weather-trigger: +${newDrafts.length} weather-driven drafts`);

        return respond(200, { ok: true, added: newDrafts.length, drafts: newDrafts.map((d) => ({ id: d.id, mode: d.context.weatherMode, scheduledFor: d.scheduledFor })) });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
