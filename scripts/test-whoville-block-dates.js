// node scripts/test-whoville-block-dates.js
// Offline tests for the shared whole-day blocked-dates list (/blocked-dates.js)
// and every server hook that enforces it. Stubs _blobs, https and fetch so
// nothing touches Netlify Blobs, SendGrid, Square, GitHub or Supabase.
const assert = require('assert');
const path = require('path');
const https = require('https');
const fn = (f) => path.join(__dirname, '..', 'netlify', 'functions', f);

require.cache[require.resolve(fn('_blobs.js'))] = {
  id: fn('_blobs.js'), filename: fn('_blobs.js'), loaded: true,
  exports: { readBlob: async () => null, writeBlob: async () => { throw new Error('writeBlob must not be called'); } },
};
const sent = [];
https.request = (opts) => { sent.push(opts.hostname + opts.path); throw new Error('network disabled in test'); };
const fetched = [];
global.fetch = async (url) => { fetched.push(String(url)); throw new Error('fetch disabled in test'); };
delete process.env.VENUE_AVAILABILITY_KEY;

(async () => {
  const B = require(fn('_blocked-dates.js'));
  assert.strictEqual(B, require(path.join(__dirname, '..', 'blocked-dates.js')), 'wrapper re-exports the root list');
  assert.deepStrictEqual(B.WHOVILLE_BLOCK_DATES,
    ['2026-12-04', '2026-12-05', '2026-12-11', '2026-12-12', '2026-12-18', '2026-12-19']);
  for (const d of B.WHOVILLE_BLOCK_DATES) assert.ok(B.isBlocked(d), d);
  assert.ok(B.isBlocked('12/4/2026') && B.isBlocked('2026-12-4') && B.isBlocked('2026-12-19T18:00:00Z'));
  for (const d of ['2026-12-10', '2026-12-03', '2026-12-13', '2026-12-20', '', null, undefined]) assert.ok(!B.isBlocked(d), String(d));
  assert.ok(/Christmas Spirits in Whoville/.test(B.blockedReason('2026-12-04')) && /quarry-events\.html/.test(B.blockedReason('2026-12-04')));
  assert.ok(/href="\/quarry-events\.html"/.test(B.NOTE_HTML));

  // Golf (square-checkout uses closedReason)
  const golf = require(fn('_golf-closed.js'));
  assert.ok(/Whoville/.test(golf.closedReason('2026-12-04', '1:00 PM')));
  assert.ok(/Whoville/.test(golf.closedReason('12/19/2026', '8:00 PM')));
  assert.strictEqual(golf.closedReason('2026-12-10', '8:00 PM'), null);

  // Pavilions
  const pav = require(fn('_pavilion-shared.js'));
  let r = await pav.isDateBookable('2026-12-04');
  assert.ok(!r.ok && r.blockedDate && /Whoville/.test(r.reason));
  assert.ok((await pav.isDateBookable('2026-12-04', { staffBlock: true })).ok, 'staff admin block still allowed');
  assert.ok((await pav.isDateBookable('2026-12-10')).ok, '12/10 bookable');
  const avail = require(fn('pavilion-availability.js'));
  let res = await avail.handler({ httpMethod: 'GET', queryStringParameters: { date: '2026-12-05' }, headers: {} });
  let b = JSON.parse(res.body);
  assert.ok(b.ok && b.bookable === false && b.blockedDate === true && b.slots.length === 0);
  res = await avail.handler({ httpMethod: 'GET', queryStringParameters: { date: '2026-12-10' }, headers: {} });
  b = JSON.parse(res.body);
  assert.ok(b.ok && b.bookable === true && b.slots.length > 0, '12/10 has slots');
  const pchk = require(fn('pavilion-checkout.js'));
  res = await pchk.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ metadata: { pavilion: '1', date: '2026-12-11', time: '5:00 PM' } }) });
  assert.strictEqual(res.statusCode, 409); assert.ok(/Whoville/.test(JSON.parse(res.body).error));

  // App party request
  process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'dummy-test';
  process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || 'dummy-test';
  const party = require(fn('party-request.js'));
  const beforeParty = sent.length + fetched.length;
  res = await party.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ name: 'T', email: 't@example.com', phone: '1', date: '2026-12-11' }) });
  assert.strictEqual(res.statusCode, 409); assert.ok(JSON.parse(res.body).blockedDate);
  assert.strictEqual(sent.length + fetched.length, beforeParty, 'party-request blocked before any save/email');

  // Netlify Forms backstop: reservations / private-events auto-reply
  process.env.RESERVATION_WEBHOOK_SECRET = 'test-wh';
  delete require.cache[require.resolve(fn('reservation-inquiry-autoreply.js'))];
  const auto = require(fn('reservation-inquiry-autoreply.js'));
  res = await auto.handler({ httpMethod: 'POST', queryStringParameters: { wh: 'test-wh' }, headers: {},
    body: JSON.stringify({ id: 'sub1', form_name: 'private-events', data: { name: 'T', email: 't@example.com', date: '2026-12-18' } }) });
  // SendGrid is stubbed to throw, so the blocked branch reports 500 -- but it
  // must have tried the decline email, NOT the confirm-link email.
  assert.strictEqual(res.statusCode, 500);
  assert.ok(sent.some((s) => /sendgrid/.test(s)));
  assert.ok(!fetched.some((u) => /confirm-interest/.test(u)));

  // Whole client+server source sanity: every public page loads the shared list.
  const fs = require('fs');
  for (const p of ['quarry-reservations.html', 'quarry-private-events.html', 'quarry-golf.html', 'quarry-pavilions.html', 'weddings/contact.html', 'quarry-app-customized.html']) {
    assert.ok(fs.readFileSync(path.join(__dirname, '..', p), 'utf8').includes('<script src="/blocked-dates.js"></script>'), p);
  }
  console.log('test-whoville-block-dates: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
