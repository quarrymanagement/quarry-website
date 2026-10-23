// ============================================================================
// admin-event-pii.js — events.json WITH buyer contact details, admin only.
//
// Since 2026-10-22 buyer name/email/phone are no longer stored in the public
// events.json; they live in the Supabase vault (event_registrant_pii, see
// supabase/migrations/20261022120000_event_registrant_pii.sql). The admin
// dashboard calls this to get the same document it used to read from
// the GitHub contents API (_github-data), with PII re-attached.
//
// GET  /.netlify/functions/admin-event-pii      header x-admin-token: <session token>
//   -> 200 { data: <events.json hydrated>, hydrated: <n> }
//   -> 401 bad/missing token, 502 GitHub/vault error
// Owner tokens and 'events_staff' tokens (same as save-events) are accepted.
// ============================================================================
const { isAuthorized } = require('./_admin-auth');
const { hydrateDoc } = require('./_event-pii');
const { readRepoText, readRepoJson } = require('./_github-data');

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };
  if (!isAuthorized(event, null, ['events_staff'])) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Admin session required' }) };
  }
  try {
    const data = await readRepoJson('events.json', { fresh: true });
    const hydrated = await hydrateDoc(data);
    return { statusCode: 200, headers, body: JSON.stringify({ data, hydrated }) };
  } catch (e) {
    console.error('admin-event-pii:', e.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
