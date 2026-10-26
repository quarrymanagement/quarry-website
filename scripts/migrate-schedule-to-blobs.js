#!/usr/bin/env node
// ============================================================================
// migrate-schedule-to-blobs.js — one-off move of schedule.json (public GitHub)
// into the private Netlify Blobs store "staff-schedule". Prints COUNTS ONLY.
//
//   NETLIFY_AUTH_TOKEN=... node scripts/migrate-schedule-to-blobs.js --from /tmp/schedule.json [--dry-run] [--force]
//   NETLIFY_AUTH_TOKEN=... node scripts/migrate-schedule-to-blobs.js --verify
//   NETLIFY_AUTH_TOKEN=... node scripts/migrate-schedule-to-blobs.js --drop-legacy-hashes [--dry-run]
//
// --from     source file (take it from main at go-live time: see DEPLOY.md)
// --force    overwrite an existing blob (default: refuse)
// --drop-legacy-hashes   password-reset step: delete every old salt:sha256
//            login (they were public). Staff then get a temporary password
//            from the owner (admin > Staff > Edit > Set temp password).
// ============================================================================
const fs = require('fs');
const { getStore } = require('@netlify/blobs');

const SITE_ID = process.env.NETLIFY_SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const dry = flag('--dry-run');

function store() {
  if (global.__TEST_STORE__) return global.__TEST_STORE__;
  const token = process.env.NETLIFY_AUTH_TOKEN || '';
  if (!token) { console.error('NETLIFY_AUTH_TOKEN not set'); process.exit(2); }
  return getStore({ name: 'staff-schedule', siteID: SITE_ID, token, consistency: 'strong' });
}

function counts(doc, creds) {
  const e = doc.employees || [];
  const c = creds || {};
  const kinds = Object.values(c).reduce((a, x) => { const k = String(x.hash).startsWith('scrypt$') ? 'scrypt' : 'legacy'; a[k] = (a[k] || 0) + 1; return a; }, {});
  return {
    employees: e.length,
    withEmail: e.filter((x) => x.email).length,
    withPhone: e.filter((x) => x.phone).length,
    weeks: Object.keys(doc.schedules || {}).length,
    timeOffRequests: (doc.timeOffRequests || []).length,
    credentials: Object.keys(c).length, credentialKinds: kinds,
    hashesLeftInDoc: e.filter((x) => x.passwordHash).length,
  };
}

async function main() {
  const s = store();
  if (flag('--verify')) {
    const doc = await s.get('schedule', { type: 'json' });
    const creds = await s.get('credentials', { type: 'json' });
    if (!doc) { console.log('NOT MIGRATED: staff-schedule/schedule is empty'); process.exit(1); }
    console.log('blob:', JSON.stringify(counts(doc, creds)));
    return;
  }
  if (flag('--drop-legacy-hashes')) {
    const creds = (await s.get('credentials', { type: 'json' })) || {};
    const keep = {}; let dropped = 0;
    for (const [id, c] of Object.entries(creds)) {
      if (String(c.hash).startsWith('scrypt$')) keep[id] = c; else dropped++;
    }
    console.log(`legacy logins to drop: ${dropped}; scrypt logins kept: ${Object.keys(keep).length}`);
    if (!dry) {
      await s.setJSON('credentials-backup-' + new Date().toISOString().replace(/[:.]/g, ''), creds);
      await s.setJSON('credentials', keep);
      console.log('done (backup written as credentials-backup-<ts>)');
    }
    return;
  }
  const from = val('--from');
  if (!from) { console.error('--from <file> required'); process.exit(2); }
  const src = JSON.parse(fs.readFileSync(from, 'utf8'));
  if (!Array.isArray(src.employees) || src.employees.length === 0) { console.error('source has no employees; refusing'); process.exit(2); }
  const creds = {};
  const employees = src.employees.map((e) => {
    const c = { ...e };
    if (c.passwordHash) creds[c.id] = { hash: c.passwordHash, mustChange: false, setAt: null, legacy: true };
    delete c.passwordHash;
    return c;
  });
  const doc = { employees, schedules: src.schedules || {}, timeOffRequests: src.timeOffRequests || [], lastUpdated: new Date().toISOString(), migratedFrom: 'github:schedule.json' };
  console.log('source:', JSON.stringify(counts(src, {})));
  console.log('to write:', JSON.stringify(counts(doc, creds)));
  const existing = await s.get('schedule', { type: 'json' });
  if (existing && !flag('--force')) { console.error('staff-schedule/schedule already exists; use --verify, or --force to overwrite'); process.exit(3); }
  if (dry) { console.log('dry run: nothing written'); return; }
  if (existing) await s.setJSON('backup-pre-migrate-' + Date.now(), existing);
  await s.setJSON('schedule', doc);
  await s.setJSON('credentials', creds);
  console.log('written. Run --verify.');
}

main().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
