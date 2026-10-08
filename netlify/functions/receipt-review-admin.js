// ============================================================================
// receipt-review-admin.js
//
// Admin-only proxy for the Receipt Review tab. Same session-token scheme as
// every other admin function; owner only, because approving or denying changes
// a customer's points balance.
//
// POST { token, action: 'list' }
// POST { token, action: 'resolve', id, decision: 'approve'|'deny', note }
// POST { token, action: 'digest' }   -- sends the digest email now
// ============================================================================
const crypto = require('crypto');
const { callEdge, sendDigest } = require('./_receipt-review-shared');

const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const SESSION_TTL_HOURS = 168;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }
// Owner tokens only ("<issued>.<sig>").
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

  try {
    if (body.action === 'list') {
      const r = await callEdge({ action: 'list' });
      return reply(r.status, r.body);
    }
    if (body.action === 'resolve') {
      const id = parseInt(body.id, 10);
      if (!id || !['approve', 'deny'].includes(body.decision)) return reply(400, { ok: false, error: 'bad_request' });
      const r = await callEdge({ action: 'resolve', id, decision: body.decision, note: String(body.note || '').slice(0, 500), by: 'management' });
      return reply(r.status, r.body);
    }
    if (body.action === 'digest') {
      return reply(200, { ok: true, ...(await sendDigest()) });
    }
    return reply(400, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return reply(500, { ok: false, error: String(e.message || e) });
  }
};
