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

  const labelId = event.queryStringParameters?.labelId;
  if (!labelId) {
    return response(400, { success: false, error: 'Missing labelId parameter' });
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

    // List messages with this label
    const searchRes = await gmail.users.messages.list({
      userId: 'me',
      labelIds: [labelId],
      maxResults: 50,
    });

    const messages = searchRes.data.messages || [];

    if (messages.length === 0) {
      return response(200, { success: true, threads: [], total: 0 });
    }

    // Fetch details for each message
    const details = await Promise.all(
      messages.slice(0, 30).map(msg =>
        gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'Date', 'From', 'To'],
        })
      )
    );

    const threadMap = new Map();

    for (const detail of details) {
      const msg = detail.data;
      const threadId = msg.threadId;

      // Only keep the latest message per thread
      if (threadMap.has(threadId)) {
        const existing = threadMap.get(threadId);
        existing.messageCount++;
        continue;
      }

      const headers = msg.payload?.headers || [];
      const getHeader = (name) => {
        const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
        return h ? h.value : '';
      };

      const subject = getHeader('Subject') || '(no subject)';
      const dateStr = getHeader('Date');
      const from = getHeader('From');
      const to = getHeader('To');
      const snippet = msg.snippet || '';

      let date = '';
      try {
        date = new Date(dateStr).toISOString();
      } catch (e) {
        date = dateStr;
      }

      // Parse contact info from form submissions or email headers
      const contactInfo = parseContactFromSnippet(snippet, from, to);

      threadMap.set(threadId, {
        id: threadId,
        subject,
        date,
        snippet: snippet.substring(0, 200),
        from,
        to,
        contact: contactInfo,
        link: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
        messageCount: 1,
      });
    }

    const threads = Array.from(threadMap.values())
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    return response(200, {
      success: true,
      threads,
      total: messages.length,
    });
  } catch (error) {
    console.error('Gmail Label API error:', error.message);

    if (error.message.includes('invalid_grant') || error.message.includes('Token')) {
      return response(401, {
        success: false,
        error: 'Gmail auth error: ' + error.message,
      });
    }

    return response(500, { success: false, error: error.message });
  }
};

// Parse contact details from form submission snippets or email headers
function parseContactFromSnippet(snippet, from, to) {
  const contact = { name: '', email: '', phone: '', occasion: '', date: '', time: '', guests: '' };

  // Try to parse structured form data (Netlify form submissions)
  const nameMatch = snippet.match(/Name:\s*([^\n]+?)(?:\s*Email:|$)/i);
  const emailMatch = snippet.match(/Email:\s*([^\s]+@[^\s]+)/i);
  const phoneMatch = snippet.match(/Phone:\s*([^\n]+?)(?:\s*Occasion:|$)/i);
  const occasionMatch = snippet.match(/Occasion:\s*([^\n]+?)(?:\s*Date:|$)/i);
  const dateMatch = snippet.match(/Date:\s*([^\n]+?)(?:\s*Time:|$)/i);
  const timeMatch = snippet.match(/Time:\s*([^\n]+?)(?:\s*Guests:|$)/i);
  const guestsMatch = snippet.match(/Guests:\s*([^\n]+?)(?:\s*Location:|$)/i);

  if (nameMatch) contact.name = nameMatch[1].trim();
  if (emailMatch) contact.email = emailMatch[1].trim();
  if (phoneMatch) contact.phone = phoneMatch[1].trim();
  if (occasionMatch) contact.occasion = occasionMatch[1].trim();
  if (dateMatch) contact.date = dateMatch[1].trim();
  if (timeMatch) contact.time = timeMatch[1].trim();
  if (guestsMatch) contact.guests = guestsMatch[1].trim();

  // If no structured data, extract from email headers
  if (!contact.name && from) {
    const fromNameMatch = from.match(/^"?([^"<]+)"?\s*</);
    if (fromNameMatch) contact.name = fromNameMatch[1].trim();
  }
  if (!contact.email && from) {
    const fromEmailMatch = from.match(/<([^>]+)>/);
    if (fromEmailMatch) contact.email = fromEmailMatch[1].trim();
    // Skip system emails
    if (contact.email === 'formresponses@netlify.com') {
      contact.email = '';
    }
  }

  return contact;
}
