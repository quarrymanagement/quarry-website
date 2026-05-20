// Temporary diagnostic — confirms the Square credentials Netlify is using.
// DELETE after debugging. Returns the first/last few chars of the token (not the full token),
// plus the result of a /v2/locations call from the function's own runtime.

const https = require('https');

function call(method, path, token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'connect.squareup.com',
      path: path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Square-Version': '2024-12-18',
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end();
  });
}

exports.handler = async () => {
  const t = process.env.SQUARE_ACCESS_TOKEN || '';
  const masked = t.length > 12 ? (t.slice(0,6) + '...' + t.slice(-6)) : '(empty)';

  // Check for any sneaky whitespace
  const trimmed = t.trim();
  const hasWhitespace = trimmed !== t;
  const hasNewline = /[\r\n]/.test(t);

  const locationsResp = await call('GET', '/v2/locations', t);
  const locationsResp_trimmed = await call('GET', '/v2/locations', trimmed);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tokenMasked: masked,
      tokenLength: t.length,
      hasWhitespace,
      hasNewline,
      env: process.env.SQUARE_ENVIRONMENT || '(unset)',
      locationId: process.env.SQUARE_LOCATION_ID || '(unset)',
      locationsCall: { status: locationsResp.status, body: locationsResp.body.slice(0, 400) },
      locationsCallTrimmed: { status: locationsResp_trimmed.status, body: locationsResp_trimmed.body.slice(0, 400) }
    }, null, 2)
  };
};
