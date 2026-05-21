// ============================================================================
// diag-blobs.js — quick round-trip test to confirm @netlify/blobs is working
//
// GET /.netlify/functions/diag-blobs
//   Writes a test JSON value, reads it back, returns ok=true if match.
//   Used once after the Netlify Blobs SDK migration to verify the fix; can be
//   left in place as an ongoing canary.
// ============================================================================
const { readBlob, writeBlob } = require('./_blobs');

exports.handler = async () => {
  const stamp = new Date().toISOString();
  const path = 'diag/round-trip';
  const payload = { stamp, marker: 'quarry-blobs-canary' };

  const writeOk = await writeBlob(path, payload);
  const readBack = await readBlob(path);
  const matches = readBack && readBack.stamp === stamp && readBack.marker === payload.marker;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: writeOk && matches,
      writeOk,
      matches,
      wrote: payload,
      readBack,
    }, null, 2),
  };
};
