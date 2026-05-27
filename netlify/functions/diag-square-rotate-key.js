// ============================================================================
// diag-square-rotate-key.js
// Rotates the signing key on the named Square webhook subscription and returns
// the new key. Caller must update SQUARE_WEBHOOK_SIGNATURE_KEY in Netlify env
// to match, or signature verification will fail.
// Hit: /.netlify/functions/diag-square-rotate-key?token=quarry2026&subId=wbhk_529461693ca14c4682a52f091568d740
// ============================================================================
const https = require('https');

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
  const subId = qs.subId;
  if (!subId) return { statusCode: 400, body: JSON.stringify({ error: 'missing subId' }) };

  const res = await sqApi('POST', '/v2/webhooks/subscriptions/' + subId + '/signature-key', {});
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(res, null, 2)
  };
};
