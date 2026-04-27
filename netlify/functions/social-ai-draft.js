// ============================================================================
// social-ai-draft.js
//
// Generates platform-specific social media post drafts (Facebook + Instagram)
// using Claude. Different from email — short captions, hashtag-aware, image
// prompt included for DALL-E.
//
// POST /.netlify/functions/social-ai-draft
// body: {
//   type: 'band_announce' | 'menu_spotlight' | 'wine_club' | 'weather_patio'
//       | 'event_promo' | 'brand_post' | 'manual',
//   platforms: ['facebook','instagram'] (default both),
//   context: { ...rule context — band info, dish, event, weather, etc. },
//   instructions: 'string — optional user steering',
//   model: 'claude' | 'openai'
// }
//
// Returns:
// {
//   success: true,
//   caption: '...',           // main copy, no hashtags
//   hashtags: ['#A','#B'],    // 6-10 strategically chosen
//   imagePrompt: '...',       // DALL-E prompt for hero image
//   suggestedTime: 'ISO',     // best send time per learnings
//   variants: { facebook: '...', instagram: '...' }  // platform-tweaked copy
// }
// ============================================================================

const https = require('https');
const fetch = require('node-fetch');

const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY    = process.env.OPENAI_API_KEY;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

const BRAND_SYSTEM_PROMPT = `You are the social media copywriter for The Quarry — an upscale-casual restaurant, wine bar, live music venue, and Hole-In-One Golf entertainment space at 3960 Highway Z, New Melle, Missouri. Open Wed-Sun, closed Mon-Tue. We do NOT take individual table reservations (walk-in dining), but we DO book private events / weddings / corporate gatherings.

BRAND VOICE — same as our email but tightened for social:
- Warm, confident, upscale-casual. Short sentences. Mobile-first.
- Lead with the strongest specific. Skip "Excited to announce!" / "We're thrilled".
- Never use exclamation marks (1 max per post; usually 0).
- 2 emojis max per caption — sparingly, only when they ADD meaning. None is fine.
- No clickbait. No begging. No "Tag a friend who…"
- Address followers as "you" or "we", never "guys" or "y'all".

PLATFORM-SPECIFIC RULES:
- FACEBOOK: 200-400 chars works best. Links allowed and clickable. Slightly more conversational.
- INSTAGRAM: 100-200 chars optimal (hooks in first 90 chars before "See more" fold). Links NOT clickable in feed (mention "link in bio"). Hashtags work — put them at end.
- BOTH: AI-generated image required (DALL-E will run on the imagePrompt you provide).

HASHTAG STRATEGY (instagram only — Facebook usually ignores):
- 6-10 hashtags, never more
- Mix: 3-5 hyper-local (#NewMelleMO, #StCharlesCounty, #DefianceWineCountry, #STLEats, #LakeStLouisMO, #WentzvilleMO, #OFallonMO)
- 3-5 category (#WineBar, #LiveMusic, #STLWine, #PatioSeason, #FoodieFinds, #DateNight, #RestaurantStl)
- Skip overused mega-tags (#instagood, #photooftheday) — they don't help small accounts

IMAGE PROMPT GUIDELINES (you generate the prompt, DALL-E creates the image):
- Photographic, warm tone, golden hour lighting
- Specific subject (NOT generic). Examples:
  - Menu: "Close-up overhead photo of a perfectly plated wood-fired flatbread with prosciutto and arugula on a rustic dark slate, warm golden lighting, restaurant interior softly blurred behind"
  - Wine: "Two stemmed wine glasses with deep red wine on a wooden bar top at golden hour, soft bokeh of warm bar lights behind, no people"
  - Live music: "Acoustic guitar leaning against a wooden chair on a string-lit patio at dusk, warm bokeh, no people, hint of stage in background"
  - Patio: "Beautiful outdoor restaurant patio at golden hour, string lights overhead, empty dining table set for two, warm and inviting, no people in frame"
- AVOID: faces (DALL-E faces look uncanny), text/logos in image (DALL-E text is garbled), specific brand names

OUTPUT FORMAT (strict JSON, no prose, no markdown fences):
{
  "caption": "Main caption text — leave hashtags OUT, they go in their own field",
  "hashtags": ["#hashtag1","#hashtag2", ...],
  "imagePrompt": "DALL-E prompt — be specific, evocative, no people faces, no text in image",
  "suggestedTimeHourCT": 11,
  "variants": {
    "facebook": "Optionally a slightly longer FB version. If null, use 'caption' as-is.",
    "instagram": "Optionally a tightened IG version. If null, use 'caption' as-is."
  },
  "reasoning": "1 sentence — why this caption + image fit the goal"
}`;

function buildUserPrompt(type, context, instructions, learnings) {
    const typeGuidance = {
        'band_announce':   `Live music announcement. Include band name, day-of-week, time slot. Frame as an invitation, not a sales pitch. Note that all live music is free with a visit.`,
        'menu_spotlight':  `Single dish spotlight. Sensory language. What's distinctive about this dish? When is it available?`,
        'wine_club':       `Wine of the week or wine club spotlight. Confident but not pretentious. Mention Rock & Vine Wine Club benefits if appropriate.`,
        'weather_patio':   `Perfect-weather patio invite. Weather is the hook (sunset, breeze, low humidity). Vibe-forward.`,
        'event_promo':     `Promote an upcoming event/show. Build anticipation. Date + time clear. Specific ticket / RSVP info if applicable.`,
        'brand_post':      `Brand post — could be venue beauty shot, value reminder (private events, weddings), or just a vibe check.`,
        'manual':          `Freeform. Use the context and instructions as the brief.`
    };
    const guidance = typeGuidance[type] || typeGuidance['manual'];

    let prompt = `POST TYPE: ${type}\n\nGUIDANCE\n${guidance}\n\nCONTEXT\n${JSON.stringify(context || {}, null, 2)}`;

    if (Array.isArray(learnings) && learnings.length) {
        const top = learnings.filter((l) => !l.supersededAt).slice(0, 6).map((l) => `- ${l.insight}`).join('\n');
        if (top) prompt += `\n\nINSIGHTS FROM PAST POSTS (apply these):\n${top}`;
    }
    if (instructions && instructions.trim()) {
        prompt += `\n\nADDITIONAL USER INSTRUCTIONS:\n${instructions.trim()}`;
    }
    prompt += `\n\nReturn ONLY the strict JSON object described in the system prompt. No backticks, no commentary.`;
    return prompt;
}

function callClaude(systemPrompt, userPrompt) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 1500, temperature: 0.6,
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
                try { const p = JSON.parse(body); resolve(p.content && p.content[0] && p.content[0].text); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject); req.write(payload); req.end();
    });
}

function tryParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }
function extractJson(text) {
    let clean = (text || '').trim();
    const fence = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence) clean = fence[1].trim();
    let parsed = tryParse(clean);
    if (parsed) return parsed;
    const firstBrace = clean.indexOf('{');
    if (firstBrace >= 0) {
        let depth = 0, end = -1, inStr = false, esc = false;
        for (let i = firstBrace; i < clean.length; i++) {
            const ch = clean[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') inStr = !inStr;
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end > firstBrace) parsed = tryParse(clean.slice(firstBrace, end + 1));
    }
    return parsed;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') return respond(405, { success: false, error: 'POST only' });
    if (!ANTHROPIC_KEY) return respond(500, { success: false, error: 'ANTHROPIC_API_KEY not configured' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { success: false, error: 'Invalid JSON' }); }

    const { type = 'manual', context = {}, instructions = '', platforms = ['facebook', 'instagram'] } = body;

    // Optionally pull learnings
    let learnings = [];
    try {
        const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=social_learnings.json`);
        if (r.ok) {
            const d = await r.json();
            learnings = (d.decoded && Array.isArray(d.decoded.learnings)) ? d.decoded.learnings : [];
        }
    } catch (_) {}

    const userPrompt = buildUserPrompt(type, context, instructions, learnings);

    let raw;
    try { raw = await callClaude(BRAND_SYSTEM_PROMPT, userPrompt); }
    catch (err) { return respond(500, { success: false, error: 'Claude call failed: ' + err.message }); }

    const parsed = extractJson(raw);
    if (!parsed || !parsed.caption || !parsed.imagePrompt) {
        return respond(500, {
            success: false,
            error: 'AI returned non-JSON or incomplete output',
            raw: (raw || '').slice(0, 500)
        });
    }

    return respond(200, {
        success: true,
        caption: parsed.caption,
        hashtags: parsed.hashtags || [],
        imagePrompt: parsed.imagePrompt,
        variants: parsed.variants || { facebook: null, instagram: null },
        suggestedTimeHourCT: parsed.suggestedTimeHourCT || 11,
        reasoning: parsed.reasoning || '',
        platforms,
        type,
        model: 'claude-sonnet-4-6'
    });
};
