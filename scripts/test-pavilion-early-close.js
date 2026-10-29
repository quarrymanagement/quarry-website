// node scripts/test-pavilion-early-close.js
// Offline tests for the early-close mechanism (pavilions + golf guard).
// The shipped EARLY_CLOSE_DATES is empty (the 10/31/2026 4 PM close was cancelled),
// so this test injects a test entry for 2026-10-31 at 4 PM to exercise the code path.
// Stubs _blobs and https so nothing touches Netlify Blobs or Square.
const assert = require('assert');
const path = require('path');
const https = require('https');
const fn = (f) => path.join(__dirname, '..', 'netlify', 'functions', f);

require.cache[require.resolve(fn('_blobs.js'))] = {
  id: fn('_blobs.js'), filename: fn('_blobs.js'), loaded: true,
  exports: { readBlob: async () => null, writeBlob: async () => {} },
};
let squareCalls = 0;
https.request = () => { squareCalls++; throw new Error('network disabled in test'); };
delete process.env.VENUE_AVAILABILITY_KEY;

const golf = require(fn('_golf-closed.js'));
assert.deepStrictEqual(Object.keys(golf.EARLY_CLOSE_DATES), [], 'shipped EARLY_CLOSE_DATES should be empty');
assert.strictEqual(golf.closedReason('2026-10-31', '8:00 PM'), null);
golf.EARLY_CLOSE_DATES['2026-10-31'] = 16; // test-only injection
const shared = require(fn('_pavilion-shared.js'));
const avail = require(fn('pavilion-availability.js'));
const checkout = require(fn('pavilion-checkout.js'));

(async () => {
  // golf behavior unchanged
  assert.ok(golf.closedReason('2026-10-31', '4:00 PM'));
  assert.ok(golf.closedReason('2026-10-31', '8:00 PM'));
  assert.strictEqual(golf.closedReason('2026-10-31', '3:00 PM'), null);
  assert.strictEqual(golf.closedReason('2026-11-07', '5:00 PM'), null);
  assert.ok(/golf bays/.test(golf.closedReason('10/31/2026', '4 PM')));

  // shared helper
  assert.strictEqual(shared.slotClosedReason('2026-10-31', '11:00 AM'), null);
  assert.ok(shared.slotClosedReason('2026-10-31', '5:00 PM'));
  assert.ok(shared.slotClosedReason('2026-10-31', '4:00 PM'));
  assert.ok(shared.slotClosedReason('2026-10-31', 'garbage'));
  assert.strictEqual(shared.slotClosedReason('2026-10-30', '5:00 PM'), null);
  assert.strictEqual(shared.slotClosedReason('2026-11-07', '5:00 PM'), null);

  const get = async (date) => JSON.parse((await avail.handler({ httpMethod: 'GET', queryStringParameters: { date } })).body);
  const a31 = await get('2026-10-31');
  const s11 = a31.slots.find((s) => s.time === '11:00 AM');
  const s5 = a31.slots.find((s) => s.time === '5:00 PM');
  assert.ok(Object.values(s11.pavilions).every(Boolean) && !s11.closed);
  assert.ok(s5.closed && Object.values(s5.pavilions).every((v) => v === false) && /4 PM/.test(s5.reason));
  for (const d of ['2026-10-30', '2026-11-07']) {
    const a = await get(d);
    assert.ok(a.slots.length === 2 && a.slots.every((s) => !s.closed && Object.values(s.pavilions).every(Boolean)), d);
  }

  const post = async (date, time) => {
    const r = await checkout.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ metadata: { pavilion: '3', date, time, customerName: 'Test', customerEmail: 'test@example.com' } }) });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  for (let p = 1; p <= 6; p++) {
    const r = await checkout.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ metadata: { pavilion: String(p), date: '2026-10-31', time: '5:00 PM' } }) });
    assert.strictEqual(r.statusCode, 409);
    assert.ok(/closes early at 4 PM/.test(JSON.parse(r.body).error));
  }
  assert.strictEqual(squareCalls, 0, 'no Square call for a closed slot');
  // open slot proceeds to the Square step (network stubbed -> 500, 1 call)
  const ok = await post('2026-10-31', '11:00 AM');
  assert.strictEqual(squareCalls, 1); assert.strictEqual(ok.status, 500);
  const ok2 = await post('2026-11-07', '5:00 PM');
  assert.strictEqual(squareCalls, 2); assert.strictEqual(ok2.status, 500);
  console.log('PASS: pavilion early-close + golf guard tests');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
