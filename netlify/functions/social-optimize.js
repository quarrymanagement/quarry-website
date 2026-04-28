// ============================================================================
// social-optimize.js — Engagement Learning Loop
//
// Nightly cron. Reads social_drafts.json (post history) + social_events.json
// (Meta engagement aggregates). Identifies what's WORKING (top decile by reach
// or engagement rate) and what's NOT (bottom decile). Uses Claude to extract
// actionable insights, writes them to social_learnings.json so they feed back
// into every future caption generation via social-ai-draft.
//
// Learnings format:
// {
//   id: 'lrn-...',
//   createdAt: 'ISO',
//   insight: 'one-line actionable rule',
//   evidence: 'short supporting data',
//   confidence: 'high|medium|low',
//   category: 'timing|format|content|hashtags|imagery',
//   supersededAt: null  // can be marked stale by later passes
// }
// ============================================================================

const https = require('https');
const fetch = require('node-fetch');

const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

function callClaude(systemPrompt, userPrompt) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 2000, temperature: 0.3,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
        });
        const req = https.request({
            hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('Anthropic ' + res.statusCode + ': ' + body.slice(0, 400)));
                try { resolve(JSON.parse(body).content[0].text); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject); req.write(payload); req.end();
    });
}

function tryParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }
function extractJsonArray(text) {
    let clean = (text || '').trim();
    const fence = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence) clean = fence[1].trim();
    let parsed = tryParse(clean);
    if (Array.isArray(parsed)) return parsed;
    const i = clean.indexOf('['), j = clean.lastIndexOf(']');
    if (i >= 0 && j > i) parsed = tryParse(clean.slice(i, j + 1));
    return Array.isArray(parsed) ? parsed : [];
}

// ----------------------------------------------------------------------------
// Build the analysis context — top vs bottom posts, by-time, by-type
// ----------------------------------------------------------------------------
function summarizePost(d, agg) {
    const a = agg || {};
    const fb = a.facebook || {};
    const ig = a.instagram || {};
    const reach = (fb.reach || 0) + (ig.reach || 0);
    const likes = (fb.likes || 0) + (ig.likes || 0);
    const comments = (fb.comments || 0) + (ig.comments || 0);
    const engagements = likes + comments + (fb.engagements || 0);
    const engagementRate = reach > 0 ? engagements / reach : 0;
    return {
        id: d.id,
        type: d.type,
        cadenceTag: d.cadenceTag,
        platforms: d.platforms,
        scheduledFor: d.scheduledFor,
        postedAt: d.postedAt,
        captionLength: (d.caption || '').length,
        captionPreview: (d.caption || '').slice(0, 120),
        hashtagCount: (d.hashtags || []).length,
        hashtagSample: (d.hashtags || []).slice(0, 5),
        hadUserImage: !!d.userImageUrl,
        hadAiImage: !!d.imageUrl && !d.userImageUrl,
        hourCT: d.scheduledFor ? new Date(d.scheduledFor).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }) : null,
        dayOfWeek: d.scheduledFor ? new Date(d.scheduledFor).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Chicago' }) : null,
        reach, likes, comments, engagements, engagementRate
    };
}

function buildAnalysisInput(drafts, aggregates) {
    const cutoff = Date.now() - 60 * 86400000;  // last 60 days
    const posted = drafts.filter((d) => d.status === 'posted' && d.postedAt && new Date(d.postedAt).getTime() >= cutoff);
    const summarized = posted.map((d) => summarizePost(d, aggregates[d.id])).filter((s) => s.reach > 0);
    if (summarized.length < 5) return null;  // not enough data yet
    summarized.sort((a, b) => b.engagementRate - a.engagementRate);
    const top = summarized.slice(0, Math.max(3, Math.floor(summarized.length * 0.25)));
    const bottom = summarized.slice(-Math.max(3, Math.floor(summarized.length * 0.25)));
    return {
        totalPosted: summarized.length,
        avgReach: summarized.reduce((s, x) => s + x.reach, 0) / summarized.length,
        avgEngagementRate: summarized.reduce((s, x) => s + x.engagementRate, 0) / summarized.length,
        top,
        bottom
    };
}

// ----------------------------------------------------------------------------
// Prompt for Claude — extract crisp, actionable rules
// ----------------------------------------------------------------------------
const OPTIMIZER_SYSTEM = `You analyze social media performance for The Quarry, a wine-bar / restaurant / live-music venue in New Melle, MO. Your job is to find ACTIONABLE patterns that will improve future post engagement, and write them as crisp one-line rules a copywriter can follow.

Look for patterns in what TOP posts have in common vs what BOTTOM posts share:
- Timing (day of week, hour CT)
- Post type (event_promo / band_announce / wine_club / atmosphere)
- Caption length, structure (question? CTA? specific? sensory?)
- Hashtag patterns (which sets work, total count)
- Image source (user-uploaded poster vs AI-generated atmospheric)
- Cadence position (T-7 / T-3 / day-of for events)

OUTPUT FORMAT — strict JSON array of insights, no prose:
[
  {
    "insight": "one-line actionable rule (e.g., 'Post band announcements on Wednesday 6pm CT — 2.4× the engagement of Thursday 11am')",
    "evidence": "supporting data point from the analysis (numbers + sample size)",
    "confidence": "high|medium|low",
    "category": "timing|format|content|hashtags|imagery"
  }
]

Limit yourself to 3-7 of the strongest insights. Skip anything that's <2x effect size or based on <3 posts. Don't repeat existing learnings (will be shown).
If the data is too thin to find real patterns, return an empty array [].`;

function buildUserPrompt(analysis, existingLearnings) {
    return `ANALYSIS WINDOW: last 60 days
TOTAL POSTED: ${analysis.totalPosted}
AVG REACH: ${Math.round(analysis.avgReach)}
AVG ENGAGEMENT RATE: ${(analysis.avgEngagementRate * 100).toFixed(2)}%

TOP-PERFORMING POSTS (by engagement rate):
${JSON.stringify(analysis.top, null, 2)}

BOTTOM-PERFORMING POSTS:
${JSON.stringify(analysis.bottom, null, 2)}

EXISTING LEARNINGS (don't repeat — supersede only if you have stronger evidence):
${(existingLearnings || []).filter((l) => !l.supersededAt).map((l) => `- ${l.insight} [${l.category}]`).join('\n') || '(none yet)'}

Return the strict JSON array only.`;
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------
exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (!ANTHROPIC_KEY) return respond(500, { ok: false, error: 'ANTHROPIC_API_KEY not configured' });

    try {
        const [draftsRes, eventsRes, learningsRes] = await Promise.all([
            loadFile('social_drafts.json'),
            loadFile('social_events.json').catch(() => ({ data: { aggregates: {}, events: [] }, sha: null })),
            loadFile('social_learnings.json').catch(() => ({ data: { learnings: [] }, sha: null })),
        ]);
        const drafts = Array.isArray(draftsRes.data.drafts) ? draftsRes.data.drafts : [];
        const aggregates = eventsRes.data.aggregates || {};
        const learningsFile = learningsRes.data;
        learningsFile.learnings = Array.isArray(learningsFile.learnings) ? learningsFile.learnings : [];

        const analysis = buildAnalysisInput(drafts, aggregates);
        if (!analysis) {
            return respond(200, { ok: true, message: 'Not enough data yet — need at least 5 posted+polled posts. Will retry tomorrow.', addedLearnings: 0 });
        }

        const raw = await callClaude(OPTIMIZER_SYSTEM, buildUserPrompt(analysis, learningsFile.learnings));
        const newLearnings = extractJsonArray(raw);

        if (!Array.isArray(newLearnings) || newLearnings.length === 0) {
            return respond(200, {
                ok: true,
                message: 'No new patterns above confidence threshold this run.',
                analysisSize: analysis.totalPosted,
                addedLearnings: 0
            });
        }

        const ts = new Date().toISOString();
        const formatted = newLearnings.map((l, i) => ({
            id: `lrn-${Date.now().toString(36)}-${i}`,
            createdAt: ts,
            insight: l.insight || '',
            evidence: l.evidence || '',
            confidence: l.confidence || 'medium',
            category: l.category || 'content',
            supersededAt: null
        })).filter((l) => l.insight);

        // Cap total learnings at 30 to keep the prompt window reasonable (drop oldest non-superseded)
        learningsFile.learnings = learningsFile.learnings.concat(formatted);
        if (learningsFile.learnings.length > 30) {
            learningsFile.learnings.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
            learningsFile.learnings = learningsFile.learnings.slice(0, 30);
        }
        learningsFile.lastRunAt = ts;
        learningsFile.lastSummaryNote = `+${formatted.length} insights from ${analysis.totalPosted} posts`;

        await saveFile('social_learnings.json', learningsFile, learningsRes.sha,
            `social-optimize: +${formatted.length} learnings`);

        return respond(200, {
            ok: true,
            addedLearnings: formatted.length,
            analysisSize: analysis.totalPosted,
            avgReach: Math.round(analysis.avgReach),
            avgEngagementRate: analysis.avgEngagementRate,
            newInsights: formatted.map((l) => l.insight)
        });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
