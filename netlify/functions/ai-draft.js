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

EMAIL STRUCTURE (ALWAYS — your output is wrapped in a navy + gold + cream branded template with a logo header, hero image, and gold "Reserve a Table" CTA appended automatically)
- Opening line: one sentence that establishes context. Use {firstName} when natural.
- An <h1> headline OR a strong opening paragraph. (Pick one — don't do both.)
- 2-4 short paragraphs OR a list. NEVER a wall of text.
- For event/show roundups: use the EVENT CARD pattern (see below).
- A short sign-off — "See you soon, The team at The Quarry" works.
- DO NOT include: <html>, <head>, <body>, <style>, your own background colors,
  your own font-family, the address, the unsubscribe link, the social icons,
  or your own "Reserve a Table" button. ALL of that is provided by the template.

OUTPUT TAGS YOU CAN USE (the wrapper styles them brand-consistently)
- <h1>          big serif headline (use ONCE per email, near the top)
- <h2>          serif section heading
- <h3>          short uppercase gold eyebrow ("THIS WEEKEND", "MENU SPOTLIGHT")
- <p>           body paragraph — keep to 2-4 sentences each
- <ul>/<li>     simple bulleted list
- <hr>          subtle divider between sections
- <a href="…">  inline link (gold underline, automatically UTM-tagged)
- <div class="event-card">     event/show card container
   <div class="event-date">FRI · MAY 1</div>
   <div class="event-title">Live Music: Janet Martin</div>
   <div class="event-meta">7 PM – 10 PM · No cover</div>
- DO NOT use inline style="" attributes — the wrapper handles all styling.

OUTPUT FORMAT (strict JSON, no prose outside JSON)
{
  "subject": "string — 40 to 60 characters, no emoji",
  "htmlBody": "string — clean HTML using ONLY the tags above. No <style>, no <body>, no inline backgrounds.",
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

// Strip the AI's outer wrapper divs/tables so they don't conflict with our template.
// AI sometimes emits <div style="background:#fff;font-family:Georgia;..."> wrapping its
// real content — that conflicts with our brand-styled card container.
function stripOuterWrappers(html) {
    if (!html) return '';
    let s = String(html).trim();
    // remove leading/trailing <html>, <body>, <div> wrappers up to 3 deep
    for (let i = 0; i < 3; i++) {
        const m = s.match(/^<(div|table|tbody|tr|td|center)[^>]*>([\s\S]*)<\/\1>\s*$/i);
        if (!m) break;
        s = m[2].trim();
    }
    return s;
}

// Strip duplicate outer wrappers the AI sometimes adds (its own background,
// its own font-family wrapper, etc.) so the template's styles can take over.
function stripOuterWrappers(html) {
    if (!html) return '';
    let s = String(html).trim();
    // If the AI wrapped everything in a single outermost <div style="...">, peel it off.
    const m = s.match(/^<div[^>]*>([\s\S]*)<\/div>\s*$/i);
    if (m) {
        const inner = m[1].trim();
        // Only peel if the outer div carries layout/background/font (otherwise it's a real wrapper)
        if (/background|font-family|max-width|padding\s*:/i.test(s.slice(0, s.indexOf('>') + 1))) {
            s = inner;
        }
    }
    // Strip <body>, <html>, <head> and <!doctype> if AI included them
    s = s.replace(/<\/?(html|body|head)[^>]*>/gi, '').replace(/<!doctype[^>]*>/gi, '');
    // Drop AI-supplied <style> blocks — our template provides them
    s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
    return s.trim();
}

function wrapWithFooter(htmlBody) {
    // Brand assets — absolute URLs required for email clients
    const LOGO_URL = 'https://thequarrystl.com/assets/quarry-q-logo.png';
    const HERO_URL = 'https://thequarrystl.com/assets/img/quarry-hero-1280.jpg';
    const WEB_URL  = 'https://www.thequarrystl.com';
    const FB_URL   = 'https://www.facebook.com/thequarrystl';
    const IG_URL   = 'https://www.instagram.com/thequarrystl';
    const UNSUB_URL = 'https://www.thequarrystl.com/.netlify/functions/unsubscribe?email={email}';
    const RES_URL  = 'https://www.thequarrystl.com/quarry-reservations.html?utm_source=email&utm_medium=marketing&utm_campaign=footer-cta';

    // Brand palette — matches the Live Bands social flyer aesthetic
    const NAVY     = '#1a2942';
    const NAVY_DK  = '#0f1a2e';
    const CREAM    = '#f5efde';
    const GOLD     = '#9a7b2a';
    const GOLD_LT  = '#c9a44a';
    const TEXT     = '#2c2c2c';
    const MUTED    = '#6b6b6b';
    const CREAM_ON_NAVY = '#f3ecd9';

    htmlBody = stripOuterWrappers(htmlBody);

    // Inline-SVG social icons render in Gmail, Apple Mail, modern Outlook, Yahoo. Falls
    // back to nothing in Outlook 2016 desktop — but the surrounding link text + box stays
    // clickable, so functionality is preserved.
    // SVG social icons in cream so they pop against the navy footer
    const ICON = (svg) => `<span style="display:inline-block;width:20px;height:20px;vertical-align:middle;line-height:0;">${svg}</span>`;
    const webIcon = ICON(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${CREAM_ON_NAVY}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`);
    const fbIcon  = ICON(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${CREAM_ON_NAVY}" width="20" height="20"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`);
    const igIcon  = ICON(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${CREAM_ON_NAVY}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`);

    // Universal styles for AI-generated content (we inject these so AI doesn't have to manage colors)
    const bodyStyles = `
        <style>
            .qbody { font-family: 'Helvetica Neue', Arial, sans-serif; color: ${TEXT}; line-height: 1.65; }
            .qbody h1 { font-family: 'Playfair Display', Georgia, serif; color: ${NAVY}; font-size: 28px; line-height: 1.25; margin: 0 0 18px; font-weight: 700; }
            .qbody h2 { font-family: 'Playfair Display', Georgia, serif; color: ${NAVY}; font-size: 22px; line-height: 1.3; margin: 28px 0 14px; font-weight: 700; }
            .qbody h3 { font-family: 'Helvetica Neue', Arial, sans-serif; color: ${GOLD}; font-size: 12px; line-height: 1.3; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: 0.16em; font-weight: 700; }
            .qbody p  { font-size: 16px; line-height: 1.7; color: ${TEXT}; margin: 0 0 16px; }
            .qbody ul, .qbody ol { margin: 0 0 16px 18px; padding: 0; font-size: 16px; line-height: 1.7; }
            .qbody li { margin: 0 0 8px; }
            .qbody a  { color: ${GOLD}; text-decoration: underline; }
            .qbody hr { border: 0; border-top: 1px solid #d4ccb3; margin: 24px 0; }
            .qbody .event-card { background: rgba(255,255,255,0.6); border-left: 4px solid ${GOLD}; padding: 14px 16px; margin: 0 0 14px; border-radius: 4px; }
            .qbody .event-date { font-size: 12px; color: ${GOLD}; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; margin: 0 0 4px; }
            .qbody .event-title { font-family: 'Playfair Display', Georgia, serif; font-size: 18px; color: ${NAVY}; font-weight: 700; margin: 0 0 4px; }
            .qbody .event-meta { font-size: 13px; color: ${MUTED}; margin: 0; }
        </style>`;

    const container = `<!doctype html><html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<meta name="format-detection" content="telephone=no">
<title>The Quarry</title>
${bodyStyles}
</head>
<body style="margin:0;padding:0;background:${NAVY};-webkit-text-size-adjust:100%;">

<!-- Outer navy canvas -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${NAVY};">
  <tr><td align="center" style="padding:24px 12px;">

    <!-- Email card (cream parchment) -->
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${CREAM};border-radius:8px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.18);">

      <!-- ═══ NAVY MAST: gold Q + brand + linked tagline ═══ -->
      <tr><td align="center" style="background:${NAVY};padding:24px 24px 18px;">
        <a href="${WEB_URL}" style="text-decoration:none;display:inline-block;">
          <img src="${LOGO_URL}" alt="The Quarry" width="64" height="64" style="display:block;margin:0 auto 8px;border:0;outline:none;">
        </a>
        <div style="font-family:'Playfair Display',Georgia,serif;font-size:24px;color:${CREAM_ON_NAVY};letter-spacing:0.14em;font-weight:700;line-height:1;">THE QUARRY</div>
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;color:${GOLD_LT};letter-spacing:0.22em;text-transform:uppercase;margin-top:10px;font-weight:600;">
          <a href="https://www.thequarrystl.com/quarry-drinks.html?utm_source=email&utm_medium=marketing&utm_campaign=header-tagline&utm_content=wine"   style="color:${GOLD_LT};text-decoration:none;">Wine</a> &nbsp;·&nbsp;
          <a href="https://www.thequarrystl.com/quarry-menu.html?utm_source=email&utm_medium=marketing&utm_campaign=header-tagline&utm_content=bites"   style="color:${GOLD_LT};text-decoration:none;">Bites</a> &nbsp;·&nbsp;
          <a href="https://www.thequarrystl.com/quarry-bands.html?utm_source=email&utm_medium=marketing&utm_campaign=header-tagline&utm_content=music"  style="color:${GOLD_LT};text-decoration:none;">Live Music</a> &nbsp;·&nbsp;
          <a href="https://www.thequarrystl.com/quarry-golf.html?utm_source=email&utm_medium=marketing&utm_campaign=header-tagline&utm_content=golf"    style="color:${GOLD_LT};text-decoration:none;">Golf</a>
        </div>
      </td></tr>

      <!-- ═══ HERO IMAGE (full-bleed) ═══ -->
      <tr><td style="padding:0;line-height:0;font-size:0;">
        <a href="${WEB_URL}" style="display:block;">
          <img src="${HERO_URL}" alt="The Quarry — patio, live music, and the lake at sunset" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;">
        </a>
      </td></tr>

      <!-- ═══ BODY (cream, AI-generated content rendered with .qbody styles) ═══ -->
      <tr><td class="qbody" style="background:${CREAM};padding:32px 32px 16px;">
        ${htmlBody}
      </td></tr>

      <!-- ═══ PRIMARY CTA BUTTON (gold, large, centered) ═══ -->
      <tr><td align="center" style="background:${CREAM};padding:8px 32px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center" bgcolor="${GOLD}" style="border-radius:6px;box-shadow:0 4px 12px rgba(154,123,42,0.35);">
            <a href="${RES_URL}" style="display:inline-block;padding:16px 36px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#ffffff;text-decoration:none;border-radius:6px;">
              Reserve a Table &nbsp;→
            </a>
          </td></tr>
        </table>
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:${MUTED};margin-top:14px;letter-spacing:0.04em;">
          Wed–Sun &nbsp;·&nbsp; New Melle, MO &nbsp;·&nbsp; <a href="tel:6362248257" style="color:${GOLD};text-decoration:none;">(636) 224-8257</a>
        </div>
      </td></tr>

      <!-- ═══ NAVY FOOTER: socials + address + unsub ═══ -->
      <tr><td align="center" style="background:${NAVY_DK};padding:24px 24px 22px;">
        <div style="margin-bottom:14px;">
          <a href="${WEB_URL}" style="margin:0 10px;display:inline-block;text-decoration:none;" title="thequarrystl.com">${webIcon}</a>
          <a href="${FB_URL}" style="margin:0 10px;display:inline-block;text-decoration:none;" title="Facebook">${fbIcon}</a>
          <a href="${IG_URL}" style="margin:0 10px;display:inline-block;text-decoration:none;" title="Instagram">${igIcon}</a>
        </div>
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:${CREAM_ON_NAVY};line-height:1.5;margin-bottom:8px;">
          <strong style="color:${GOLD_LT};">The Quarry</strong> &nbsp;·&nbsp; 3960 Highway Z &nbsp;·&nbsp; New Melle, MO 63385 &nbsp;·&nbsp; (636) 224-8257
        </div>
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:rgba(243,236,217,0.55);line-height:1.6;">
          You're receiving this because you signed up, booked a reservation, or attended an event at The Quarry.<br>
          <a href="${UNSUB_URL}" style="color:rgba(243,236,217,0.75);text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp;
          <a href="https://www.thequarrystl.com/privacy.html" style="color:rgba(243,236,217,0.75);text-decoration:underline;">Privacy Policy</a>
        </div>
      </td></tr>

    </table>

    <!-- Below-card: tiny brand watermark -->
    <div style="font-family:'Playfair Display',Georgia,serif;color:rgba(243,236,217,0.30);font-size:11px;letter-spacing:0.18em;margin-top:18px;">— THE QUARRY —</div>

  </td></tr>
</table>
</body></html>`;
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
