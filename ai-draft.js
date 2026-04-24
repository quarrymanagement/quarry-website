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
{firstName} {lastName} {email}`;

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

function wrapWithFooter(htmlBody) {
    const footer = `
<div style="max-width:600px;margin:2rem auto 0;padding:1.5rem 1rem;border-top:1px solid #e0e3e8;font-family:'Montserrat',-apple-system,sans-serif;font-size:0.75rem;color:#858d9e;text-align:center;line-height:1.5;">
  <div style="margin-bottom:0.5rem;">
    <strong style="color:#4b5263;">The Quarry</strong> &middot; 3960 Highway Z, New Melle, MO 63385
  </div>
  <div style="margin-bottom:0.5rem;">
    <a href="https://www.thequarrystl.com" style="color:#9a7b2a;text-decoration:none;">thequarrystl.com</a> &middot;
    <a href="https://www.facebook.com/thequarrystl" style="color:#9a7b2a;text-decoration:none;">Facebook</a>
  </div>
  <div>
    You're receiving this because you signed up, booked a reservation, or attended an event at The Quarry.
    <a href="https://www.thequarrystl.com/unsubscribe?email={email}" style="color:#858d9e;text-decoration:underline;">Unsubscribe</a>
  </div>
</div>`;
    const container = `<div style="background:#f4f5f7;padding:2rem 1rem;font-family:'Montserrat',-apple-system,BlinkMacSystemFont,sans-serif;color:#1c1f26;line-height:1.6;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:2rem 1.5rem;box-shadow:0 2px 8px rgba(0,0,0,0.04);">
<div style="text-align:center;margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:2px solid #9a7b2a;">
  <div style="font-family:'Playfair Display',Georgia,serif;font-size:1.8rem;color:#1c1f26;letter-spacing:0.02em;">THE QUARRY</div>
</div>
${htmlBody}
</div>
${footer}
</div>`;
    return container;
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

    // Parse the model's JSON response
    let parsed;
    try {
        // Some models wrap JSON in code fences even when asked not to — strip them
        let clean = result.content.trim();
        if (clean.startsWith('```')) {
            clean = clean.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }
        parsed = JSON.parse(clean);
    } catch (e) {
        return response(500, {
            success: false,
            error: 'AI returned non-JSON output: ' + e.message,
            raw: result.content.slice(0, 500),
        });
    }

    const subject = (parsed.subject || '').trim();
    const inner = (parsed.htmlBody || '').trim();
    if (!subject || !inner) {
        return response(500, { success: false, error: 'AI output missing subject or htmlBody', raw: parsed });
    }

    const htmlBody = wrapWithFooter(inner);

    return response(200, {
        success: true,
        subject: subject,
        htmlBody: htmlBody,
        innerHtml: inner,
        model: result.model,
        tokensUsed: result.tokens,
        suggestedRecipientFilter: parsed.suggestedRecipientFilter || 'Subscribed',
        reasoning: parsed.reasoning || '',
    });
};
