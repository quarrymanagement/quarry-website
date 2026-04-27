// ============================================================================
// ai-draft.js — AI marketing draft generator for The Quarry
//
// POST /.netlify/functions/ai-draft
// Body: {
//   type: 'event_promo_30d' | 'event_promo_14d' | 'event_promo_7d' | 'event_promo_2d'
//       | 'rescue' | 'weekly_digest' | 'wine_club' | 'golf' | 'menu_spotlight'
//       | 'weather_patio' | 'evergreen' | 'manual',
//   context: { ...event/band/menu/weather data relevant to `type` },
//   model:   'openai' | 'claude'   (default 'openai'),
//   instructions: string (optional — extra instructions, e.g. for regenerate
//                                     'make it shorter' or 'more playful'),
// }
//
// Returns: {
//   success: true,
//   subject: string,
//   htmlBody: string (complete inline-styled email body including footer),
//   model:   string (actual model name used),
//   tokensUsed: number,
//   suggestedRecipientFilter: 'Subscribed' | 'Wine Club' | 'Golf' | 'Event Attendees',
// }
//
// Security: OPENAI_API_KEY (required) and ANTHROPIC_API_KEY (optional) from env.
// Never echoes keys. Never writes user data outside response.
// ============================================================================

const https = require('https');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const response = (statusCode, body) => ({
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

// ============================================================================
// BRAND VOICE + CAN-SPAM FOOTER
// ============================================================================

const BRAND_SYSTEM_PROMPT = `You are the marketing copywriter for The Quarry, an upscale-casual restaurant and event venue at 3960 Highway Z, New Melle, Missouri 63385.

BRAND VOICE
- Upscale-casual, warm, confident. Think: refined neighborhood restaurant with personality.
- Not stuffy. Not kitschy. Never cheesy.
- Uses "you" and "we" naturally. Avoids corporate-speak ("synergy", "leverage", "excited to announce").
- At most one exclamation point per email. Never multiple in a row.
- No emoji. No all-caps shouting.
- Subject lines are specific and curiosity-driven, not clickbait. 40-60 characters.
- Short paragraphs (2-3 sentences). Scannable. Mobile-first.

EMAIL STRUCTURE (ALWAYS)
- Opening line that establishes context in one sentence.
- 1-2 short paragraphs of detail.
- One clear call-to-action button (gold background #9a7b2a, white text).
- A short sign-off. Never use "Cheers," or "Best,".
- Footer is appended automatically — DO NOT include address, unsubscribe link, or social links yourself.

OUTPUT FORMAT (strict JSON, no prose outside JSON)
Return an object with these exact keys:
{
  "subject": "string — 40 to 60 characters, no emoji",
  "htmlBody": "string — HTML email body with inline styles. Max-width 600px container. Use merge tags {firstName} where natural (sparingly). Start from <div style=...> root. Do NOT include <html>, <head>, or <body> tags. Do NOT include the footer — it will be appended.",
  "suggestedRecipientFilter": "Subscribed" | "Wine Club" | "Golf" | "Event Attendees",
  "reasoning": "1 sentence — why this subject + structure fits the goal"
}

MERGE TAGS (available but use sparingly)
{firstName} {lastName} {email}

PERSONALIZATION (when first names are available in the segment):
- Subject lines that lead with a first name open at ~2x the rate of generic subjects.
  When natural, use {firstName} in the subject — e.g. "{firstName}, the patio's open Saturday".
  Don't force it on every subject; only when it reads naturally and the audience is
  large enough that personalization will reach most recipients.
- Opening lines can use {firstName} too — once per email at most.

SUBJECT LINE QUALITY CHECKLIST (apply silently before returning):
- Length: 30-60 characters preferred (40-50 sweet spot)
- No ALL CAPS words (one short ALL CAPS word OK if intentional)
- No excessive punctuation (avoid !!!, ???, multiple emojis)
- Avoid spam-trigger phrasing: "Free!", "Act now", "Limited time only", "Click here"
- Lead with specifics, not generic hype`;

function buildUserPrompt(type, context, instructions) {
    const typeGuidance = {
        'event_promo_30d': `Write a SAVE-THE-DATE email for an upcoming event 30 days out. Warm and anticipatory. Don't push reservations hard yet — build interest. CTA: "See details".`,
        'event_promo_14d': `Write a REMINDER email for an event 14 days out. More details now. Mention capacity if relevant. CTA: "Reserve your spot".`,
        'event_promo_7d': `Write a 1-WEEK-OUT reminder. Create gentle urgency. Highlight what makes this event special. CTA: "Reserve now".`,
        'event_promo_2d': `Write a LAST-CALL email 2 days out. Direct, warm, a touch urgent. CTA: "Grab the last seats".`,
        'rescue': `Write an UNDER-FILLED RESCUE push. Event has low signups and is close. Be warm, not desperate. Focus on what guests will love. CTA: "Join us".`,
        'weekly_digest': `Write THIS WEEK AT THE QUARRY — a roundup of bands playing and events happening this week. Scannable list format. Each item 1-2 lines with its own small link.`,
        'wine_club': `Wine Club email — monthly release notes, member-only vibe, confident and knowledgeable but not pretentious.`,
        'golf': `Golf event or league promo. Straightforward, a touch of camaraderie.`,
        'menu_spotlight': `Feature a menu item or new menu launch. Sensory language. One specific dish, not a laundry list.`,
        'weather_patio': `Weather-triggered "perfect patio night" post. Short, immediate, welcoming. Reference the weekend/evening specifically.`,
        'evergreen': `Evergreen brand message — hours, reservations, "we're open tonight" tone.`,
        'manual': `Freeform marketing email. Use the context and instructions as the brief.`,
    };

    const guidance = typeGuidance[type] || typeGuidance['manual'];

    let prompt = `CONTENT TYPE: ${type}\n\nGUIDANCE\n${guidance}\n\nCONTEXT DATA\n${JSON.stringify(context || {}, null, 2)}`;
    if (instructions && instructions.trim()) {
        prompt += `\n\nADDITIONAL INSTRUCTIONS FROM USER\n${instructions.trim()}`;
    }
    prompt += `\n\nReturn ONLY the strict JSON object described in the system prompt. No backticks, no markdown fences, no commentary.`;
    return prompt;
}

// UTM-tag every <a href> inside the inner HTML so we can attribute web traffic
// + reservations back to specific marketing sends in GA / server logs.
function tagUtms(html, ruleId) {
    if (!html) return html;
    const campaign = (ruleId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-');
    return String(html).replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi, (full, href) => {
        // skip merge tags and tel:/mailto:
        if (/^(mailto:|tel:|#)/i.test(href)) return full;
        if (/^https?:\/\//i.test(href)) {
            const sep = href.includes('?') ? '&' : '?';
            const utm = `utm_source=email&utm_medium=marketing&utm_campaign=${encodeURIComponent(campaign)}`;
            // don't double-tag if utm_source already present
            const newHref = /utm_source=/i.test(href) ? href : (href + sep + utm);
            return full.replace(href, newHref);
        }
        return full;
    });
}

function wrapWithFooter(htmlBody) {
    // Brand assets — absolute URLs required for email clients
    const LOGO_URL = 'https://thequarrystl.com/assets/quarry-q-logo.png';
    const WEB_URL  = 'https://www.thequarrystl.com';
    const FB_URL   = 'https://www.facebook.com/thequarrystl';
    const IG_URL   = 'https://www.instagram.com/thequarrystl';
    const UNSUB_URL = 'https://www.thequarrystl.com/.netlify/functions/unsubscribe?email={email}';

    // Inline-SVG social icons render in Gmail, Apple Mail, modern Outlook, Yahoo. Falls
    // back to nothing in Outlook 2016 desktop — but the surrounding link text + box stays
    // clickable, so functionality is preserved.
    const ICON = (svg) => `<span style="display:inline-block;width:18px;height:18px;vertical-align:middle;line-height:0;">${svg}</span>`;
    const webIcon = ICON('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#9a7b2a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>');
    const fbIcon  = ICON('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#9a7b2a" width="18" height="18"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>');
    const igIcon  = ICON('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#9a7b2a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>');

    const footer = `
<div style="max-width:600px;margin:2rem auto 0;padding:1.5rem 1rem;border-top:1px solid #e0e3e8;font-family:'Montserrat',-apple-system,sans-serif;font-size:0.75rem;color:#858d9e;text-align:center;line-height:1.5;">
  <div style="margin-bottom:0.85rem;">
    <a href="${WEB_URL}" style="color:#9a7b2a;text-decoration:none;margin:0 0.6rem;display:inline-block;" title="thequarrystl.com">${webIcon}</a>
    <a href="${FB_URL}" style="color:#9a7b2a;text-decoration:none;margin:0 0.6rem;display:inline-block;" title="Facebook">${fbIcon}</a>
    <a href="${IG_URL}" style="color:#9a7b2a;text-decoration:none;margin:0 0.6rem;display:inline-block;" title="Instagram">${igIcon}</a>
  </div>
  <div style="margin-bottom:0.5rem;">
    <strong style="color:#4b5263;">The Quarry</strong> &middot; 3960 Highway Z, New Melle, MO 63385 &middot; (636) 224-8257
  </div>
  <div>
    You're receiving this because you signed up, booked a reservation, or attended an event at The Quarry.
    <a href="${UNSUB_URL}" style="color:#858d9e;text-decoration:underline;">Unsubscribe</a> &middot;
    <a href="https://www.thequarrystl.com/privacy.html" style="color:#858d9e;text-decoration:underline;">Privacy Policy</a>
  </div>
</div>`;

    const container = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:#f4f5f7;"><div style="background:#f4f5f7;padding:2rem 1rem;font-family:'Montserrat',-apple-system,BlinkMacSystemFont,sans-serif;color:#1c1f26;line-height:1.6;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:2rem 1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
<div style="text-align:center;margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:2px solid #9a7b2a;">
  <a href="${WEB_URL}" style="text-decoration:none;display:inline-block;">
    <img src="${LOGO_URL}" alt="The Quarry — wine, bites, live music, and golf in New Melle, MO" width="72" height="72" style="display:block;margin:0 auto 0.5rem;border:0;outline:none;text-decoration:none;">
  </a>
  <div style="font-family:'Playfair Display',Georgia,serif;font-size:1.4rem;color:#1c1f26;letter-spacing:0.08em;">THE QUARRY</div>
  <div style="font-family:'Montserrat',sans-serif;font-size:0.7rem;color:#858d9e;letter-spacing:0.18em;text-transform:uppercase;margin-top:0.25rem;">Wine &middot; Bites &middot; Live Music &middot; Golf</div>
</div>
${htmlBody}
</div>
${footer}
</div></body></html>`;
    return container;
}

// Generate a plain-text version of the HTML for the multipart/alternative body.
// Spam filters (especially corporate Outlook) downrank HTML-only emails.
function htmlToPlainText(html) {
    if (!html) return '';
    return String(html)
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => `${text.replace(/<[^>]+>/g,'').trim()} (${url})`)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&middot;/gi, '·').replace(/&[a-z]+;/gi, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Subject-line quality analysis — surfaces warnings the admin UI can show.
function analyzeSubject(subject) {
    const s = String(subject || '');
    const warnings = [];
    if (s.length < 30) warnings.push(`short (${s.length} chars; sweet spot 40-60)`);
    else if (s.length > 70) warnings.push(`long (${s.length} chars; mobile preview cuts off ~50)`);
    const allCapsWords = (s.match(/\b[A-Z]{4,}\b/g) || []);
    if (allCapsWords.length > 1) warnings.push(`multiple ALL CAPS words: ${allCapsWords.join(', ')}`);
    if (/!{2,}|\?{2,}/.test(s)) warnings.push('repeated punctuation (!! or ??)');
    if (/(free|act now|limited time|click here|urgent|guarantee|congratulations|winner|cash|earn \$)/i.test(s)) warnings.push('contains spam-trigger phrasing');
    const emojiCount = (s.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
    if (emojiCount > 1) warnings.push(`${emojiCount} emojis (max 1 recommended)`);
    return { length: s.length, warnings, score: Math.max(0, 100 - warnings.length * 15) };
}

// ============================================================================
// OPENAI CALLER
// ============================================================================

function callOpenAI(systemPrompt, userPrompt) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            reject(new Error('OPENAI_API_KEY not configured in Netlify env vars'));
            return;
        }

        const payload = JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.75,
            max_tokens: 1800,
            response_format: { type: 'json_object' },
        });

        const req = https.request({
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error('OpenAI HTTP ' + res.statusCode + ': ' + body.slice(0, 500)));
                    return;
                }
                try {
                    const parsed = JSON.parse(body);
                    const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
                    const tokens = parsed.usage && parsed.usage.total_tokens;
                    if (!content) {
                        reject(new Error('OpenAI returned empty content'));
                        return;
                    }
                    resolve({ content: content, tokens: tokens || 0, model: parsed.model || 'gpt-4o-mini' });
                } catch (e) {
                    reject(new Error('Failed to parse OpenAI response: ' + e.message));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// ============================================================================
// ANTHROPIC CALLER (stub — used only if ANTHROPIC_API_KEY is present)
// ============================================================================

function callAnthropic(systemPrompt, userPrompt) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            reject(new Error('ANTHROPIC_API_KEY not configured — add it in Netlify env vars to enable Claude'));
            return;
        }

        const payload = JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1800,
            temperature: 0.75,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
        });

        const req = https.request({
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error('Anthropic HTTP ' + res.statusCode + ': ' + body.slice(0, 500)));
                    return;
                }
                try {
                    const parsed = JSON.parse(body);
                    const content = parsed.content && parsed.content[0] && parsed.content[0].text;
                    const tokens = (parsed.usage && (parsed.usage.input_tokens + parsed.usage.output_tokens)) || 0;
                    if (!content) {
                        reject(new Error('Anthropic returned empty content'));
                        return;
                    }
                    resolve({ content: content, tokens: tokens, model: parsed.model || 'claude-sonnet-4-6' });
                } catch (e) {
                    reject(new Error('Failed to parse Anthropic response: ' + e.message));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// ============================================================================
// HANDLER
// ============================================================================

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return response(405, { success: false, error: 'Method not allowed. Use POST.' });
    }

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch (e) {
        return response(400, { success: false, error: 'Invalid JSON body' });
    }

    const type = body.type || 'manual';
    const context = body.context || {};
    const model = (body.model || 'openai').toLowerCase();
    const instructions = body.instructions || '';

    const userPrompt = buildUserPrompt(type, context, instructions);

    let result;
    try {
        if (model === 'claude' || model === 'anthropic') {
            result = await callAnthropic(BRAND_SYSTEM_PROMPT, userPrompt);
        } else {
            result = await callOpenAI(BRAND_SYSTEM_PROMPT, userPrompt);
        }
    } catch (err) {
        return response(500, { success: false, error: err.message });
    }

    // Parse the model's JSON response. Models occasionally wrap output in
    // markdown fences, add a preamble, or trail off mid-token. Try several
    // recovery strategies before giving up.
    let parsed;
    function tryParse(s) {
        try { return JSON.parse(s); } catch (_) { return null; }
    }
    let clean = (result.content || '').trim();
    // 1) Strip markdown fences anywhere in the string
    const fence = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence) clean = fence[1].trim();
    // 2) Direct parse
    parsed = tryParse(clean);
    // 3) Extract the first {...} block (greedy, balanced-brace heuristic)
    if (!parsed) {
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
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) { end = i; break; }
                }
            }
            if (end > firstBrace) parsed = tryParse(clean.slice(firstBrace, end + 1));
        }
    }
    if (!parsed) {
        return response(500, {
            success: false,
            error: 'AI returned non-JSON output (after recovery attempts). Try Redo again with simpler instructions.',
            raw: (result.content || '').slice(0, 600),
        });
    }

    const subject = (parsed.subject || '').trim();
    const inner = (parsed.htmlBody || '').trim();
    if (!subject || !inner) {
        return response(500, { success: false, error: 'AI output missing subject or htmlBody', raw: parsed });
    }

    // Tag UTMs into the inner HTML before wrapping (so footer-injected links
    // stay clean and only the AI-generated CTAs get tagged).
    const ruleHint = (body.context && body.context.ruleId) || (body.context && body.context.eventId) || type;
    const taggedInner = tagUtms(inner, ruleHint);
    const htmlBody = wrapWithFooter(taggedInner);

    return response(200, {
        success: true,
        subject: subject,
        htmlBody: htmlBody,
        plainText: htmlToPlainText(taggedInner),
        subjectQuality: analyzeSubject(subject),
        innerHtml: taggedInner,
        model: result.model,
        tokensUsed: result.tokens,
        suggestedRecipientFilter: parsed.suggestedRecipientFilter || 'Subscribed',
        reasoning: parsed.reasoning || '',
    });
};
