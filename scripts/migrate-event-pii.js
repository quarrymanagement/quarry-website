#!/usr/bin/env node
// ============================================================================
// scripts/migrate-event-pii.js — one-time move of buyer PII out of events.json
// into the Supabase vault (public.event_registrant_pii).
//
// Run AFTER: migration applied, event-pii edge function deployed, EVENT_PII_KEY
// set in Supabase + Netlify, and the new Netlify functions live (so no writer
// re-adds PII afterwards; even if one does, the next vaulted write strips it).
//
//   GITHUB_TOKEN=... EVENT_PII_KEY=... node scripts/migrate-event-pii.js           # dry run
//   GITHUB_TOKEN=... EVENT_PII_KEY=... node scripts/migrate-event-pii.js --apply   # do it
//   node scripts/migrate-event-pii.js --file events.json                           # offline dry run
//
// --apply: fetch events.json (with sha) -> upsert every PII row -> read the
// vault back and confirm every row is present -> strip -> PUT. Retries on a
// 409 sha conflict (bots commit constantly). Prints counts only, never values.
// This only cleans the CURRENT file; git history still holds the old PII
// (see the purge notes in the PR description).
// ============================================================================
const fs = require('fs');
const path = require('path');
const pii = require('../netlify/functions/_event-pii');

const REPO = 'quarrymanagement/quarry-website';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const fileIdx = args.indexOf('--file');
const LOCAL = fileIdx >= 0 ? args[fileIdx + 1] : null;

async function gh(method, p, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
  const r = await fetch('https://api.github.com' + p, {
    method,
    headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'quarry-migrate-event-pii', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json };
}

async function fetchEvents() {
  const meta = await gh('GET', `/repos/${REPO}/contents/events.json?ref=main`);
  if (meta.status !== 200) throw new Error('GET events.json meta ' + meta.status);
  let raw;
  if (meta.json.content && meta.json.encoding === 'base64') raw = Buffer.from(meta.json.content, 'base64').toString('utf8');
  else {
    const blob = await gh('GET', `/repos/${REPO}/git/blobs/${meta.json.sha}`);
    raw = Buffer.from(blob.json.content, 'base64').toString('utf8');
  }
  return { doc: JSON.parse(raw), sha: meta.json.sha };
}

function summarize(doc) {
  const rows = pii.collectRows(doc);
  const byEvent = {};
  rows.forEach((r) => { byEvent[r.event_id] = (byEvent[r.event_id] || 0) + 1; });
  const refs = new Set(rows.map((r) => r.event_id + '\u0000' + r.ref));
  return { rows, byEvent, dupes: rows.length - refs.size };
}

async function main() {
  if (LOCAL) {
    const doc = JSON.parse(fs.readFileSync(path.resolve(LOCAL), 'utf8'));
    const s = summarize(doc);
    console.log(`[offline] ${s.rows.length} registrations carry PII across ${Object.keys(s.byEvent).length} event keys; duplicate refs: ${s.dupes}`);
    return;
  }
  for (let attempt = 1; attempt <= 6; attempt++) {
    const { doc, sha } = await fetchEvents();
    const s = summarize(doc);
    console.log(`attempt ${attempt}: ${s.rows.length} registrations with PII in ${Object.keys(s.byEvent).length} event keys (duplicate refs: ${s.dupes})`);
    if (!s.rows.length) { console.log('Nothing to migrate — events.json is already clean.'); return; }
    if (!APPLY) { console.log('Dry run only. Re-run with --apply to vault + strip.'); return; }

    await pii.upsertRows(s.rows, 'migrate-event-pii');
    // Verify every row landed before removing anything from the file.
    const vault = pii.indexRows(await pii.listRows([...new Set(s.rows.map((r) => r.event_id))]));
    const missing = s.rows.filter((r) => !vault.has(r.event_id + '\u0000' + r.ref));
    if (missing.length) throw new Error(missing.length + ' row(s) not found in the vault after upsert — aborting, events.json untouched');

    const stripped = pii.stripDoc(doc);
    if (pii.collectRows(doc).length) throw new Error('strip left PII behind — aborting');
    const content = Buffer.from(JSON.stringify(doc, null, 2), 'utf8').toString('base64');
    const put = await gh('PUT', `/repos/${REPO}/contents/events.json`, {
      message: 'Move ticket-buyer contact details out of events.json (now in Supabase vault)',
      content, sha, branch: 'main',
    });
    if (put.status === 200 || put.status === 201) {
      console.log(`Done: ${stripped} registrations stripped; commit ${put.json && put.json.commit && put.json.commit.sha}`);
      return;
    }
    if (put.status === 409 || put.status === 422) { console.log('sha conflict, retrying…'); await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
    throw new Error('PUT events.json failed ' + put.status);
  }
  throw new Error('gave up after 6 sha conflicts');
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
