// node scripts/test-events-public-feed.js — offline checks for the 2026-10-27
// events.json public projection. Uses the repo's events.json; prints counts only.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');
const root = path.join(__dirname, '..');
const raw = fs.readFileSync(path.join(root, 'events.json'), 'utf8');
const full = JSON.parse(raw);

// Stub GitHub reads so data-read / events-feed run offline.
const gh = path.join(root, 'netlify/functions/_github-data.js');
require.cache[require.resolve(gh)] = { id: gh, filename: gh, loaded: true,
  exports: { readRepoText: async () => raw, readRepoJson: async () => JSON.parse(raw) } };

const { publicEventsDoc, sanitizeEvent } = require(path.join(root, 'netlify/functions/_event-pii.js'));
const pub = publicEventsDoc(full);
// 2026-10-28: status 'draft' events are dropped from the public projection.
const isDraft = (e) => String((e && e.status) || '').toLowerCase() === 'draft';
const visible = full.events.filter((e) => !isDraft(e));
const s = JSON.stringify(pub);
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

// 1. Nothing sensitive left
['paymentId', 'orderNumber', 'transactionId', 'couponCode', 'amount', 'refundedCents', '"ref"', 'paymentMethod', '"email"', '"phone"', 'refundedRegistrations', 'customerEmail']
  .forEach((k) => ok(!s.includes(k.startsWith('"') ? k + ':' : '"' + k + '":'), 'public feed has no ' + k));
ok(Object.keys(pub.registrations || {}).length === 0, 'legacy top-level registrations emptied');
ok(Array.isArray(pub.subscribers) && pub.subscribers.length === 0, 'subscribers empty');
// 2. Shape kept
ok(JSON.stringify(Object.keys(pub)) === JSON.stringify(Object.keys(full)), 'top-level keys unchanged');
ok(pub.events.length === visible.length, 'all non-draft events kept (' + pub.events.length + ' of ' + full.events.length + ')');
ok(!pub.events.some(isDraft), 'no draft events in public feed (' + (full.events.length - visible.length) + ' hidden)');
ok(pub.events.filter((e) => e.status === 'inactive').length === full.events.filter((e) => e.status === 'inactive').length, 'inactive (cancelled) events still in feed');
ok(JSON.stringify(pub.bands) === JSON.stringify(full.bands), 'bands unchanged');
const evKeysSame = visible.every((e, i) => Object.keys(e).filter((k) => !['refundedRegistrations', 'bookedBy'].includes(k)).every((k) => k in pub.events[i]));
ok(evKeysSame, 'event fields kept (except refundedRegistrations/bookedBy)');
const nonRegSame = visible.every((e, i) => Object.keys(e).filter((k) => !['registrations', 'refundedRegistrations', 'bookedBy'].includes(k)).every((k) => JSON.stringify(e[k]) === JSON.stringify(pub.events[i][k])));
ok(nonRegSame, 'all other event fields byte-identical (ids, slugs, dates, capacity, tiers, seating, QR/detail ids)');
ok(visible.every((e, i) => (e.registrations || []).length === (pub.events[i].registrations || []).length), 'registration row counts unchanged');
// 3. Seat / wave counting identical (same logic as quarry-events.html, quarry-event-detail.html, event-register.js)
function seatingUnitsUsed(regs, opt) { const key = String((opt && (opt.id || opt.name)) || '').toLowerCase().trim(); const seats = parseInt(opt && opt.seats, 10) || 1;
  return (regs || []).reduce((n, r) => { const rid = String((r && (r.seatingOptionId || r.seatType)) || '').toLowerCase().trim(); if (rid !== key) return n; const b = parseInt(r && r.qty, 10) || seats; return n + Math.max(1, Math.round(b / seats)); }, 0); }
function arrivalUsed(ev, slot) { const key = String((slot && slot.id) || '').toLowerCase().trim(); if (!key) return 0;
  return (ev.registrations || []).reduce((n, r) => { const rid = String((r && r.arrivalSlot) || '').toLowerCase().trim(); if (!rid || rid !== key) return n;
    const o = (ev.seatingOptions || []).find((x) => String(x.id || '').toLowerCase() === String(r.seatingOptionId || r.seatType || '').toLowerCase()); const seats = parseInt(o && o.seats, 10) || 1; const b = parseInt(r && r.qty, 10) || seats; return n + Math.max(1, Math.round(b / seats)); }, 0); }
let checks = 0, same = true;
visible.forEach((e, i) => { (e.seatingOptions || []).forEach((o) => { checks++; if (seatingUnitsUsed(e.registrations, o) !== seatingUnitsUsed(pub.events[i].registrations, o)) same = false; });
  (e.arrivalSlots || []).forEach((sl) => { checks++; if (arrivalUsed(e, sl) !== arrivalUsed(pub.events[i], sl)) same = false; });
  checks++; if ((e.registrations || []).reduce((n, r) => n + (parseInt(r.qty, 10) || 0), 0) !== (pub.events[i].registrations || []).reduce((n, r) => n + (parseInt(r.qty, 10) || 0), 0)) same = false; });
ok(same, 'seat/wave/qty counts identical across ' + checks + ' checks');
ok(sanitizeEvent(full.events[0]).id === full.events[0].id, 'get-event-public sanitizeEvent keeps id');

(async () => {
  // 4. data-read: anonymous -> projection + public cache; events-feed -> projection
  const dr = require(path.join(root, 'netlify/functions/data-read.js'));
  const a = await dr.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { file: 'events.json' } });
  ok(a.statusCode === 200 && !a.body.includes('"paymentId":') && a.headers['Cache-Control'].startsWith('public'), 'data-read anonymous: projection, edge-cached');
  const ef = require(path.join(root, 'netlify/functions/events-feed.js'));
  const b = await ef.handler({ httpMethod: 'GET', headers: { 'x-admin-token': 'forged' }, queryStringParameters: { t: '123', file: 'members.json' } });
  ok(b.statusCode === 200 && !b.body.includes('"paymentId":') && JSON.parse(b.body).events.length === visible.length, 'events-feed (/events.json): projection, ignores params/headers');
  const gp = require(path.join(root, 'netlify/functions/get-event-public.js'));
  const d0 = full.events.find(isDraft), v0 = visible[0];
  if (d0) { const g = await gp.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { id: d0.id } }); ok(g.statusCode === 404, 'get-event-public: draft id -> 404'); }
  const gv = await gp.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { id: v0.id } });
  ok(gv.statusCode === 200 && JSON.parse(gv.body).event.id === v0.id, 'get-event-public: published id -> 200');
  const m = await dr.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { file: 'menu.json' } });
  ok(m.statusCode === 200 && m.body === raw, 'other public files untouched (stub)');
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
