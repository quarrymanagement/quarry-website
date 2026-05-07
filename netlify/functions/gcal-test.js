// Diagnostic: tries to create a test calendar event and dumps the FULL
// Google API error so we can see exactly what's wrong with the token.
const { google } = require('googleapis');

exports.handler = async (event) => {
  const result = { steps: [] };
  try {
    const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN;
    result.steps.push({
      step: 'env-check',
      hasNewToken: !!process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
      hasOldToken: !!process.env.GMAIL_REFRESH_TOKEN,
      hasClientId: !!process.env.GMAIL_CLIENT_ID,
      hasClientSecret: !!process.env.GMAIL_CLIENT_SECRET,
      tokenSource: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN ? 'GOOGLE_CALENDAR_REFRESH_TOKEN' : 'GMAIL_REFRESH_TOKEN',
      tokenLen: (refreshToken || '').length,
      tokenLast8: (refreshToken || '').slice(-8),
    });

    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    // Get an access token to inspect scope
    try {
      const at = await oauth2Client.getAccessToken();
      result.steps.push({ step: 'access-token-obtained', hasToken: !!at.token, scope: at.res?.data?.scope || '(unknown)' });
      // Inspect scopes via tokeninfo
      const fetch = (await import('node:https'));
      const tokenInfo = await new Promise((resolve, reject) => {
        const req = fetch.request({
          hostname: 'oauth2.googleapis.com',
          path: '/tokeninfo?access_token=' + encodeURIComponent(at.token),
          method: 'GET'
        }, (r) => { let body=''; r.on('data', c=>body+=c); r.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve({ raw: body }); } }); });
        req.on('error', reject); req.end();
      });
      result.steps.push({ step: 'tokeninfo', info: tokenInfo });
    } catch (e) {
      result.steps.push({ step: 'access-token-error', message: e.message });
    }

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // 1) Try LIST to confirm read works
    try {
      const list = await calendar.events.list({ calendarId: 'primary', maxResults: 1 });
      result.steps.push({ step: 'events.list', ok: true, count: (list.data.items || []).length });
    } catch (e) {
      result.steps.push({ step: 'events.list', ok: false, error: e.message, body: e.response?.data || e.errors });
    }

    // 2) Try INSERT (the call that's failing)
    try {
      const probe = await calendar.events.insert({
        calendarId: 'primary',
        sendUpdates: 'none',
        requestBody: {
          summary: 'Quarry calendar permission test (safe to delete)',
          description: 'Diagnostic event from gcal-test.js. Created at ' + new Date().toISOString(),
          start: { dateTime: '2026-12-31T23:00:00-06:00', timeZone: 'America/Chicago' },
          end:   { dateTime: '2026-12-31T23:30:00-06:00', timeZone: 'America/Chicago' }
        }
      });
      result.steps.push({ step: 'events.insert', ok: true, id: probe.data.id, link: probe.data.htmlLink });
    } catch (e) {
      result.steps.push({ step: 'events.insert', ok: false, error: e.message, body: e.response?.data || e.errors });
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result, null, 2) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message, ...result }) };
  }
};
