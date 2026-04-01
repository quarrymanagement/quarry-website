const { google } = require('googleapis');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const response = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return response(200, { message: 'OK' });
  }

  if (event.httpMethod !== 'GET') {
    return response(405, { success: false, error: 'Method not allowed' });
  }

  const contactEmail = event.queryStringParameters?.email;
  if (!contactEmail) {
    return response(400, { success: false, error: 'Missing email parameter' });
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );

    oauth2Client.setCredentials({
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Search for messages to/from this contact (last 50)
    const searchRes = await gmail.users.messages.list({
      userId: 'me',
      q: `from:${contactEmail} OR to:${contactEmail}`,
      maxResults: 20,
    });

    const messages = searchRes.data.messages || [];

    if (messages.length === 0) {
      return response(200, { success: true, threads: [] });
    }

    // Fetch details for each message (subject, date, snippet)
    const threadMap = new Map();

    const details = await Promise.all(
      messages.slice(0, 15).map(msg =>
        gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'Date', 'From', 'To'],
        })
      )
    );

    for (const detail of details) {
      const msg = detail.data;
      const threadId = msg.threadId;

      // Only keep the latest message per thread
      if (threadMap.has(threadId)) continue;

      const headers = msg.payload?.headers || [];
      const getHeader = (name) => {
        const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
        return h ? h.value : '';
      };

      const subject = getHeader('Subject') || '(no subject)';
      const dateStr = getHeader('Date');
      const from = getHeader('From');
      const snippet = msg.snippet || '';

      // Parse date
      let date = '';
      try {
        date = new Date(dateStr).toISOString();
      } catch (e) {
        date = dateStr;
      }

      // Determine direction
      const isInbound = from.toLowerCase().includes(contactEmail.toLowerCase());

      threadMap.set(threadId, {
        id: threadId,
        subject,
        date,
        snippet: snippet.substring(0, 120),
        from: isInbound ? contactEmail : 'me',
        direction: isInbound ? 'received' : 'sent',
        link: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
        messageCount: 1,
      });
    }

    // Count total messages per thread
    for (const detail of details) {
      const threadId = detail.data.threadId;
      if (threadMap.has(threadId)) {
        const thread = threadMap.get(threadId);
        // We already counted the first one, count additional
        if (detail.data.id !== messages.find(m => m.threadId === threadId)?.id) {
          thread.messageCount++;
        }
      }
    }

    const threads = Array.from(threadMap.values())
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    return response(200, {
      success: true,
      threads,
      total: messages.length,
    });
  } catch (error) {
    console.error('Gmail API error:', error.message);
    console.error('Full error:', JSON.stringify(error.response?.data || error));
    console.error('Env check - CLIENT_ID exists:', !!process.env.GMAIL_CLIENT_ID);
    console.error('Env check - CLIENT_SECRET exists:', !!process.env.GMAIL_CLIENT_SECRET);
    console.error('Env check - REFRESH_TOKEN exists:', !!process.env.GMAIL_REFRESH_TOKEN);
    console.error('Env check - REFRESH_TOKEN length:', (process.env.GMAIL_REFRESH_TOKEN || '').length);
    console.error('Env check - REFRESH_TOKEN starts with:', (process.env.GMAIL_REFRESH_TOKEN || '').substring(0, 10));

    if (error.message.includes('invalid_grant') || error.message.includes('Token')) {
      return response(401, {
        success: false,
        error: 'Gmail auth error: ' + error.message,
        debug: {
          clientIdExists: !!process.env.GMAIL_CLIENT_ID,
          secretExists: !!process.env.GMAIL_CLIENT_SECRET,
          tokenExists: !!process.env.GMAIL_REFRESH_TOKEN,
          tokenLength: (process.env.GMAIL_REFRESH_TOKEN || '').length,
        }
      });
    }

    return response(500, { success: false, error: error.message });
  }
};
