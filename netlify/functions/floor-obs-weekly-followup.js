// ============================================================================
// floor-obs-weekly-followup.js — scheduled (Mondays 10:00 AM CT)
//
// Sends the weekly follow-up for floor notes a manager MARKED: each person
// gets their marked note(s) again the following week, with their full history
// and a fresh Acknowledge link. All the logic lives in the Supabase edge
// function `floor-observations` (action cron_followups); this just pokes it.
//
// Safe by default — does NOTHING unless both are true:
//   1. Running on the production deploy (Netlify CONTEXT === 'production').
//      Draft / deploy-preview / branch deploys never send.
//   2. FLOOR_OBS_CRON_KEY is set in Netlify env, and its SHA-256 matches the
//      row server_observation_settings.key = 'cron_key_sha256' in Supabase.
//      (No row = the edge function refuses with 503 "disabled".)
// ============================================================================
const FN = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/floor-observations';
const KEY = 'sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl'; // publishable (public) key

exports.handler = async () => {
  const ctx = process.env.CONTEXT || '';
  const cronKey = (process.env.FLOOR_OBS_CRON_KEY || '').trim();
  if (ctx !== 'production') {
    console.log(`floor-obs-weekly-followup: no-op (context=${ctx || 'unknown'})`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'not production' }) };
  }
  if (!cronKey) {
    console.log('floor-obs-weekly-followup: no-op (FLOOR_OBS_CRON_KEY not set)');
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'not configured' }) };
  }
  try {
    const r = await fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}`, 'x-cron-key': cronKey },
      body: JSON.stringify({ action: 'cron_followups' }),
    });
    const j = await r.json().catch(() => ({}));
    const people = (j.people || []).map((p) => ({ items: p.items, sent: p.sent, skipped: p.skipped })); // no names in logs
    console.log('floor-obs-weekly-followup:', r.status, JSON.stringify({ today: j.today, people }));
    return { statusCode: 200, body: JSON.stringify({ ok: r.ok, status: r.status, count: people.length }) };
  } catch (e) {
    console.error('floor-obs-weekly-followup failed', e && e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};

// Mondays 15:00 UTC = 10:00 AM CDT / 9:00 AM CST.
exports.config = { schedule: '0 15 * * 1' };
