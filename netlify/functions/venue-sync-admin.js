// ============================================================================
// venue-sync-admin.js
//
// Owner-only: run the golf/pavilion -> venue calendar sync right now.
// POST { token, kind?: 'golf'|'pavilion' }  (omit kind to run both)
// ============================================================================
const crypto = require('crypto');
const { syncKind } = require('./_venue-sync-shared');

const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const SESSION_TTL_HOURS = 168;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }
function verifyOwner(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;
  const [issued, sig] = parts;
  if (!ADMIN_SECRET || !issued || !sig || hmac(issued, ADMIN_SECRET) !== sig) return false;
  return (Date.now() - parseInt(issued, 10)) / 3600000 < SESSION_TTL_HOURS;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return reply(400, { ok: false, error: 'invalid_json' }); }
  if (!verifyOwner(body.token)) return reply(401, { ok: false, error: 'unauthorized' });

  const kinds = body.kind ? [body.kind] : ['golf', 'pavilion'];
  const out = {};
  for (const kind of kinds) {
    if (!['golf', 'pavilion'].includes(kind)) return reply(400, { ok: false, error: 'bad_kind' });
    try { out[kind] = await syncKind(kind); }
    catch (e) { out[kind] = { ok: false, error: String(e.message || e) }; }
  }
  return reply(200, { ok: true, results: out });
};
