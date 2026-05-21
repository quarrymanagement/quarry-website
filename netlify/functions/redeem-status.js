// ============================================================================
// redeem-status.js — customer polls this to know if staff has confirmed
// their pending redemption.
//
// GET /redeem-status?code=ABC123
//   → { ok: true, status: 'pending' | 'confirmed' | 'expired' | 'not-found',
//       reward?: {...}, confirmedAt?: <iso>, newBalance?: <int> }
//
// No auth — the code itself is the secret (6 chars, ~28 bits) and it's only
// useful for 5 minutes. Lookup-only; no mutation.
// ============================================================================
const { readBlob } = require('./_blobs');
const { wrap }     = require('./_sentry');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

exports.handler = wrap('redeem-status', async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return reply(405, { ok: false, error: 'GET only' });

  const code = String((event.queryStringParameters || {}).code || '').toUpperCase().trim();
  if (!code) return reply(400, { ok: false, error: 'code required' });

  const blob = await readBlob('redemptions/' + code);
  if (!blob) return reply(200, { ok: true, status: 'not-found' });

  // TTL check
  if (blob.expiresAt && new Date(blob.expiresAt).getTime() < Date.now() && blob.status === 'pending') {
    return reply(200, { ok: true, status: 'expired', reward: redactReward(blob) });
  }

  return reply(200, {
    ok: true,
    status: blob.status || 'pending',
    code: blob.code,
    reward: redactReward(blob),
    member: { name: blob.memberName || '', email: blob.memberEmail || '' },
    expiresAt: blob.expiresAt || null,
    confirmedAt: blob.confirmedAt || null,
    confirmedBy: blob.confirmedBy || null,
    newBalance: blob.newBalance != null ? blob.newBalance : null,
  });
});

function redactReward(b) {
  return {
    id: b.rewardId || '',
    name: b.rewardName || '',
    description: b.rewardDescription || '',
    points: b.points || 0,
  };
}
