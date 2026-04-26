// ============================================================================
// marketing-optimize.js
//
// Nightly job. Reads the last 90 days of marketing_events.json and
// marketing_drafts.json (sent), summarizes them, asks Claude what patterns
// look meaningful, and writes structured insights back to
// marketing_learnings.json. Those insights feed the NEXT day's draft prompt.
//
// Also produces:
//   - Top-performing subject patterns
//   - Best send hour by day-of-week
//   - Content-type performance (event_promo_7d vs weekly_digest, etc.)
//   - Suggested future event ideas based on engagement signals
//
// Idempotent. Stamps learnings with sample size + confidence so we never
// over-rotate on a small handful of sends.
// ============================================================================

const https = require('https');
const fetch = require('node-fetch');

const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const QUARRY_DATA_KEY = process.env.QUARRY_DATA_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-quarry-key',
    'Content-Type': 'application/json'
};
const respond = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

async function loadJsonFile(file) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`);
    if (!r.ok) throw new Error(`load ${file}: ${r.status}`);
    const d = await r.json();
    return { data: d.decoded || {}, sha: d.sha };
}
async function saveJsonFile(file, json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${file}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-quarry-key': QUARRY_DATA_KEY },
        body: JSON.stringify({ json, sha, message })
    });
    if (!r.ok) throw new Error(`save ${file}: ${r.status}`);
    return r.json();
}

function callClaude(systemPrompt, userPrompt) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2400,
            temperature: 0.4,
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
                try {
                    const p = JSON.parse(body);
                    resolve(p.content && p.content[0] && p.content[0].text);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject); req.write(payload); req.end();
    });
}

function summarizeData(drafts, events, aggregates) {
    const sent = drafts.filter((d) => d.status === 'sent' && d.sentAt);
    const ninetyAgo = Date.now() - 90 * 24 * 3600 * 1000;
    const recent = sent.filter((d) => new Date(d.sentAt).getTime() >= ninetyAgo);

    const perDraft = recent.map((d) => {
        const a = aggregates[d.id] || {};
        const recipients = (d.deliveryStats && d.deliveryStats.recipientCount) || a.delivered || 0;
        const openRate = recipients ? (a.uniqueOpen || 0) / recipients : 0;
        const clickRate = recipients ? (a.uniqueClick || 0) / recipients : 0;
        const sentDate = new Date(d.sentAt);
        return {
            id: d.id,
            type: d.type,
            ruleId: d.ruleId,
            subject: d.subject,
            segment: d.segment,
            sentAt: d.sentAt,
            dayOfWeek: sentDate.getUTCDay(),
            hourCT: ((sentDate.getUTCHours() - 5) + 24) % 24,  // approx, ignores DST edge
            recipients,
            openRate: Number(openRate.toFixed(3)),
            clickRate: Number(clickRate.toFixed(3)),
            unsubs: a.unsubscribe || 0,
            spam: a.spamreport || 0
        };
    });

    return { totalSent: recent.length, perDraft };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (!ANTHROPIC_KEY) return respond(500, { error: 'ANTHROPIC_API_KEY not configured' });

    const isScheduled = (event.body && /"next_run"/.test(event.body)) ||
                        (event.headers && /netlify/i.test(event.headers['user-agent'] || ''));
    if (!isScheduled && QUARRY_DATA_KEY) {
        const provided = event.headers['x-quarry-key'] || event.headers['X-Quarry-Key'] || '';
        if (provided !== QUARRY_DATA_KEY) return respond(401, { error: 'Missing or invalid x-quarry-key header' });
    }

    try {
        const [draftsRes, eventsRes, learningsRes] = await Promise.all([
            loadJsonFile('marketing_drafts.json'),
            loadJsonFile('marketing_events.json'),
            loadJsonFile('marketing_learnings.json')
        ]);

        const drafts = (draftsRes.data.drafts || []).concat(draftsRes.data.history || []);
        const aggregates = eventsRes.data.aggregates || {};
        const events = eventsRes.data.events || [];

        const summary = summarizeData(drafts, events, aggregates);

        if (summary.totalSent < 3) {
            return respond(200, { ok: true, message: `Only ${summary.totalSent} sends in last 90d — not enough signal yet. Keeping seed insights.` });
        }

        const systemPrompt = `You are a senior email marketing analyst for The Quarry — an upscale-casual restaurant + wine bar + live music + golf venue in New Melle, MO (Wed-Sun, closed Mon/Tue).

You are reviewing recent send performance and producing structured insights that will be injected into the NEXT batch of AI-generated email drafts. Be statistically honest: if a sample is small (< 10 sends) call it 'low' confidence. Do not invent patterns that aren't supported.

OUTPUT FORMAT (strict JSON, no prose outside JSON):
{
  "learnings": [
    {
      "category": "timing" | "subject_line" | "content_pattern" | "segment_response" | "event_type" | "day_of_week",
      "insight": "concise actionable rule (max 220 chars)",
      "confidence": "low" | "medium" | "high",
      "sampleSize": <number — sends underlying this insight>
    }
  ],
  "eventIdeas": [
    {
      "title": "short event name",
      "rationale": "why this should perform well, citing engagement signals",
      "suggestedDate": "ISO date or 'recurring weekly Thu' style",
      "confidence": "low" | "medium" | "high"
    }
  ],
  "summaryNote": "one sentence summary of the period"
}`;

        const userPrompt = `Past 90 days of sends (${summary.totalSent} emails):
${JSON.stringify(summary.perDraft.slice(0, 80), null, 2)}

Brand context: Wine, bites, live music, golf. Hours Wed-Sun. Beer garden launching 2026. Wine Club exists. Service area: Wentzville, Lake Saint Louis, O'Fallon, Defiance Wine Country.

Produce 3-7 learnings (only the ones with real evidence) and 2-4 event ideas. Return ONLY the JSON.`;

        const raw = await callClaude(systemPrompt, userPrompt);
        let parsed;
        try {
            let clean = (raw || '').trim();
            if (clean.startsWith('```')) clean = clean.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
            parsed = JSON.parse(clean);
        } catch (e) {
            return respond(500, { error: 'AI returned non-JSON', raw: (raw || '').slice(0, 500) });
        }

        const learningsFile = learningsRes.data;
        const now = new Date().toISOString();

        // Mark all auto-generated learnings as superseded; keep seed-* ones forever
        for (const l of (learningsFile.learnings || [])) {
            if (!l.id.startsWith('seed-') && !l.supersededAt) l.supersededAt = now;
        }

        const newLearnings = (parsed.learnings || []).map((l, i) => ({
            id: 'auto-' + Date.now() + '-' + i,
            category: l.category,
            insight: l.insight,
            confidence: l.confidence || 'low',
            sampleSize: l.sampleSize || 0,
            createdAt: now,
            supersededAt: null
        }));

        learningsFile.learnings = [...(learningsFile.learnings || []), ...newLearnings];
        learningsFile.eventIdeas = parsed.eventIdeas || [];
        learningsFile.lastSummaryNote = parsed.summaryNote || '';
        learningsFile.lastRunAt = now;
        learningsFile.updatedAt = now;

        await saveJsonFile('marketing_learnings.json', learningsFile, learningsRes.sha,
            `optimize: +${newLearnings.length} learnings, +${(parsed.eventIdeas || []).length} event ideas`);

        return respond(200, { ok: true, addedLearnings: newLearnings.length, eventIdeas: parsed.eventIdeas, summaryNote: parsed.summaryNote });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
