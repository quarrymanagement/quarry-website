// member-code-check.js: tells the ticket page whether a member code (e.g. the wine club code) is right,
// without the code ever being in public data. POST { codeEnv: "MEMBER_CODE_WINECLUB", code } -> { ok }.
// Only env vars named MEMBER_CODE_* can be checked. event-register.js re-checks the code on every booking.
const { memberCodeEnvOk } = require('./event-register');
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  let b = {}; try { b = JSON.parse(event.body || '{}'); } catch (e) {}
  const ok = memberCodeEnvOk(String(b.codeEnv || ''), String(b.code || '').slice(0, 60));
  await new Promise((r) => setTimeout(r, 400));   // slows guessing
  return { statusCode: 200, headers, body: JSON.stringify({ ok }) };
};
