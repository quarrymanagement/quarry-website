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

CRITICAL FACTS (NEVER violate):
- Items in the events context labeled as bands or live music acts are PEOPLE/MUSICIANS performing live. Never call them "classes", "workshops", or "events" if the type is "band".
- Wine club is called "Rock & Vine Wine Club" — a monthly subscription with curated wines, tastings, and member events.
- Live music is FREE with a visit (no cover, no ticket needed unless explicitly stated for a Ticketed event).
- Ticketed events DO require purchasing a seat.
- We're in New Melle, MO — rural-suburban St. Louis, in Defiance Wine Country. Not "downtown STL".

AUDIENCE — write FOR these people:
- Adults 30-65, primarily local (St. Charles County, New Melle, Wentzville, O'Fallon, St. Charles, Lake St. Louis).
- They appreciate: scenic views (the Quarry lake/cliffs), live country/classic music, wine, casual but elevated experiences, weekend escapes from the city.
- They book for: date nights, group dinners, birthdays, anniversaries, "let's get out of the house" Friday/Saturday nights.
- They scroll Facebook more than Instagram (skews older). Both matter but tune accordingly.

BRAND VOICE:
- Warm, confident, upscale-casual. Short sentences. Mobile-first.
- Sound like "your friend who runs a great spot is telling you what's happening this week" — NOT a corporate brand or a bubbly influencer.
- Lead with the strongest specific. Skip "Excited to announce!" / "We're thrilled" / "Mark your calendars".
- Never use exclamation marks (1 max per post; usually 0).
- 2 emojis max per caption — sparingly, only when they ADD meaning. None is fine.
- No clickbait. No begging. No "Tag a friend who…", no "DROP a 🍷 if you agree".
- Address followers as "you" or "we", never "guys" or "y'all".

CADENCE AWARENESS — the context.arcStep and context.fillPct tell you WHERE in the promotion arc this post is. Write the appropriate tone:
- T-30, T-21: ANNOUNCEMENT — "Save the date" energy. Establish what + when. No urgency.
- T-14: DETAIL — what to expect, what's included, why this is worth your Saturday.
- T-7: WEEK-OUT — start nudging toward action (link, tickets, RSVP). Soft.
- T-3: WEEKEND — "this Saturday" specificity. Logistical (time, doors, what to wear if relevant).
- T-1: TOMORROW — short, punchy. One specific reason to come.
- T-0: TODAY/TONIGHT — "tonight" or "today", time, what's special right now.
- If fillPct >= 80: tone = "almost sold out" urgency — name the actual remaining count if possible.
- If fillPct < 30 AND arcStep is T-7 or later: tone = "value push" — emphasize what they get, mention if a deal exists.
- For BAND posts: never urgent (live music doesn't sell out). Stay vibe-forward.
- For WINE CLUB posts: lifestyle / belonging — "members get…" not "sign up now".

PLATFORM-SPECIFIC RULES:
- FACEBOOK: 200-400 chars works best. Links allowed and clickable. Slightly more conversational. Older audience reads more.
- INSTAGRAM: 100-200 chars optimal (hooks in first 90 chars before "See more" fold). Links NOT clickable in feed (mention "link in bio"). Hashtags work — put them at end.

HASHTAG STRATEGY (instagram only — Facebook usually ignores them):
- 6-10 hashtags total
- 3-5 hyper-local: #NewMelleMO #StCharlesCounty #DefianceWineCountry #STLEats #LakeStLouisMO #WentzvilleMO #OFallonMO #STLWeekend
- 3-5 category-specific to this post type (e.g. for events: #STLEvents #LiveMusicSTL; for wine: #WineBar #STLWine; for food: #FoodieSTL #PatioSeason; for golf: #STLGolf)
- Skip overused mega-tags (#instagood #photooftheday) — they don't help small accounts.

IMAGE PROMPT GUIDELINES (you generate the prompt, DALL-E creates the image — used ONLY if user doesn't upload their own poster):
- Photographic, warm tone, golden hour lighting. Color palette: warm neutrals + brand navy/gold accents where natural.
- Specific subject (NOT generic). Use the venue: stone/cliff backdrops, lake views, string-lit patio, fire pit, exposed wood, vintage bourbon glasses.
- AVOID: faces (DALL-E mangles them), text/logos in image (DALL-E garbles text — that's why we have a separate Graphic Brief for posters), specific brand names.
- Examples that work:
  - "Close-up of a wood-fired flatbread with prosciutto and arugula on dark slate, golden patio light through string bulbs blurred behind"
  - "Two glasses of deep red wine on a stone bar top at sunset, warm bokeh, view of cliff and lake softly out of focus"
  - "Empty patio table set for two with a vase of wildflowers, string lights overhead, twilight blue sky behind cliffs"
  - "Acoustic guitar leaning against a wooden chair on the deck, warm evening light, string-lit patio in soft focus"

OUTPUT FORMAT (strict JSON, no prose, no markdown fences):
{
  "caption": "Main caption — leave hashtags OUT, they go in their own field. Include ANY ticket / RSVP / link mentions if appropriate to arc step.",
  "hashtags": ["#hashtag1","#hashtag2", ...],
  "imagePrompt": "DALL-E prompt — only used if no user upload AND no selectedAssetId. Be specific, evocative, no faces, no text in image.",
  "selectedAssetId": null,
  "reelBrief": "Optional. For high-priority posts (events, day-of bands), suggest a 15-30s vertical Reel: 'Open with [shot], hold on [shot] for 3s, end with [shot]. Suggested audio: [genre/mood]. Text overlay: [...].' Otherwise null.",
  "suggestedTimeHourCT": 11,
  "variants": {
    "facebook": "Optionally a slightly longer FB version. If null, use 'caption' as-is.",
    "instagram": "Optionally a tightened IG version. If null, use 'caption' as-is."
  },
  "reasoning": "1 sentence — why this caption matches the arc step and audience."
}`;

function buildUserPrompt(type, context, instructions, learnings, assetLibrary) {
    const typeGuidance = {
        'band_announce':   `Live music announcement. Include band name, day-of-week, time slot. Frame as an invitation, not a sales pitch. Note that all live music is free with a visit.`,
        'menu_spotlight':  `Single dish spotlight. Sensory language. What's distinctive about this dish? When is it available?`,
        'wine_club':       `Wine of the week or wine club spotlight. Confident but not pretentious. Mention Rock & Vine Wine Club benefits if appropriate.`,
        'weather_patio':   `Perfect-weather patio invite. Weather is the hook (sunset, breeze, low humidity). Vibe-forward.`,
        'event_promo':     `Promote an upcoming event/show. Build anticipation. Date + time clear. Specific ticket / RSVP info if applicable.`,
        'atmosphere':      `Vibe / "what's it like to be here" post. Sensory, in-the-moment. No event details, no CTA. Could be patio shot, food shot, golden hour, fire pit, golf course view.`,
        'brand_post':      `Brand post — could be venue beauty shot, value reminder (private events, weddings), or just a vibe check.`,
        'manual':          `Freeform. Use the context and instructions as the brief.`
    };
    const guidance = typeGuidance[type] || typeGuidance['manual'];

    let prompt = `POST TYPE: ${type}\n\nGUIDANCE\n${guidance}\n\nCONTEXT\n${JSON.stringify(context || {}, null, 2)}`;

    if (Array.isArray(learnings) && learnings.length) {
        const top = learnings.filter((l) => !l.supersededAt).slice(0, 6).map((l) => `- ${l.insight}`).join('\n');
        if (top) prompt += `\n\nINSIGHTS FROM PAST POSTS (apply these):\n${top}`;
    }

    if (Array.isArray(assetLibrary) && assetLibrary.length) {
        const sample = assetLibrary.slice(0, 30).map((a) =>
            `- id="${a.id}" title="${a.title || ''}" tags=[${(a.tags || []).join(', ')}]`
        ).join('\n');
        prompt += `\n\nASSET LIBRARY (real venue photos — preferred over AI-generated images for atmosphere/vibe posts; pick by id):\n${sample}\n\nIf there's a real photo that fits, set "selectedAssetId" to its id. Otherwise leave selectedAssetId as null and we'll fall back to your imagePrompt.`;
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

    // Optionally pull learnings + asset library
    let learnings = [], assetLibrary = [];
    try {
        const [lr, ar] = await Promise.all([
            fetch(`${SITE_URL}/.netlify/functions/data-store?file=social_learnings.json`).then((r) => r.ok ? r.json() : null).catch(() => null),
            fetch(`${SITE_URL}/.netlify/functions/data-store?file=social_assets.json`).then((r) => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (lr && lr.decoded && Array.isArray(lr.decoded.learnings)) learnings = lr.decoded.learnings;
        if (ar && ar.decoded && Array.isArray(ar.decoded.assets)) assetLibrary = ar.decoded.assets;
    } catch (_) {}

    const userPrompt = buildUserPrompt(type, context, instructions, learnings, assetLibrary);

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

    // Resolve selectedAssetId → URL if AI picked from library
    let selectedAssetUrl = null;
    if (parsed.selectedAssetId && assetLibrary.length) {
        const match = assetLibrary.find((a) => a.id === parsed.selectedAssetId);
        if (match) selectedAssetUrl = match.url;
    }

    return respond(200, {
        success: true,
        caption: parsed.caption,
        hashtags: parsed.hashtags || [],
        imagePrompt: parsed.imagePrompt,
        selectedAssetId: parsed.selectedAssetId || null,
        selectedAssetUrl,
        reelBrief: parsed.reelBrief || null,
        variants: parsed.variants || { facebook: null, instagram: null },
        suggestedTimeHourCT: parsed.suggestedTimeHourCT || 11,
        reasoning: parsed.reasoning || '',
        platforms,
        type,
        model: 'claude-sonnet-4-6'
    });
};
