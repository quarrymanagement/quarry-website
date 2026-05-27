// ============================================================================
// diag-square-webhooks.js
// Lists active Square webhook subscriptions + signature keys so we can verify
// the subscription is configured correctly and the signing key matches
// SQUARE_WEBHOOK_SIGNATURE_KEY in Netlify env.
// Hit: /.netlify/functions/diag-square-webhooks?token=quarry2026
// ============================================================================
const https = require('https');
const crypto = require('crypto');

function sqApi(method, path, body) {
  const env = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  const host = env === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
  const payload = body ? JSON.stringify(body) : '';
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: host, path: path, method: method,
      headers: {
        'Authorization': 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
        'Square-Version': '2024-12-18',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function(res) {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, raw: d }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

exports.handler = async function(event) {
  const qs = event.queryStringParameters || {};
  if (qs.token !== 'quarry2026') {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  // 1. List webhook subscriptions
  const subsRes = await sqApi('GET', '/v2/webhooks/subscriptions?include_disabled=true');
  const subs = (subsRes.body && subsRes.body.subscriptions) || [];

  // 2. Reveal the env var's signature key (just first/last chars to confirm presence; full disclosure for compare)
  const envKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
  const envKeyPreview = envKey ? envKey.slice(0,6) + '...' + envKey.slice(-4) + ` (len=${envKey.length})` : 'MISSING';

  // 3. For each subscription, also fetch its signing key
  const subDetails = [];
  for (const s of subs) {
    let signKey = null;
    try {
      const keyRes = await sqApi('POST', '/v2/webhooks/subscriptions/' + s.id + '/signature-key', {});
      // Square only returns the key on rotate; GET doesn't expose it. We get it via the create/list response.
      signKey = (keyRes.body && keyRes.body.signature_key) || null;
    } catch (e) { /* skip */ }
    subDetails.push({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      notification_url: s.notification_url,
      event_types: s.event_types,
      api_version: s.api_version,
      signature_key_from_list: s.signature_key || null,
      // Indicate if the listed key matches env
      matches_env_key: s.signature_key && envKey ? (s.signature_key === envKey) : null
    });
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      env_signature_key_preview: envKeyPreview,
      env_signature_key_full: envKey,  // we own this endpoint, behind token
      subscription_count: subs.length,
      subscriptions: subDetails
    }, null, 2)
  };
};
