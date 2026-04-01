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

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );

    oauth2Client.setCredentials({
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // Default: fetch events from now to 3 months out
    const timeMin = event.queryStringParameters?.timeMin || new Date().toISOString();
    const timeMaxDate = new Date();
    timeMaxDate.setMonth(timeMaxDate.getMonth() + 3);
    const timeMax = event.queryStringParameters?.timeMax || timeMaxDate.toISOString();

    const calRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
    });

    const rawEvents = calRes.data.items || [];

    // Parse events into a clean format with contact info
    const events = rawEvents.map(evt => {
      const summary = evt.summary || '(No title)';
      const description = evt.description || '';
      const location = evt.location || '';
      const attendees = evt.attendees || [];

      // Extract contact info from event
      const contactInfo = parseEventContact(summary, description, attendees);

      const start = evt.start?.dateTime || evt.start?.date || '';
      const end = evt.end?.dateTime || evt.end?.date || '';

      return {
        id: evt.id,
        summary,
        description: description.substring(0, 300),
        location,
        start,
        end,
        status: evt.status,
        contact: contactInfo,
        attendees: attendees.map(a => ({
          email: a.email,
          name: a.displayName || '',
          status: a.responseStatus,
        })),
        htmlLink: evt.htmlLink,
      };
    });

    return response(200, {
      success: true,
      events,
      total: events.length,
    });
  } catch (error) {
    console.error('Google Calendar API error:', error.message);

    if (error.message.includes('invalid_grant') || error.message.includes('Token')) {
      return response(401, {
        success: false,
        error: 'Calendar auth error: ' + error.message,
      });
    }

    return response(500, { success: false, error: error.message });
  }
};

// Parse contact info from calendar event data
function parseEventContact(summary, description, attendees) {
  const contact = { name: '', email: '', phone: '', guests: '', occasion: '' };

  // Parse summary patterns like "Name - Occasion (X people)" or "Name | Occasion"
  const summaryPatterns = [
    /^(.+?)\s*[-–]\s*(.+?)\s*\((\d+[^)]*)\)/,   // "Teri Unterreiner - 60th Birthday Gathering (25 people)"
    /^(.+?)\s*\|\s*(.+)/,                          // "Happy Hour | Jill"
    /^(.+?)\s*[-–]\s*(.+)/,                         // "Name - Occasion"
  ];

  for (const pattern of summaryPatterns) {
    const match = summary.match(pattern);
    if (match) {
      // Check which group has the name vs occasion
      contact.name = match[1].trim();
      contact.occasion = match[2].trim();
      if (match[3]) contact.guests = match[3].trim();
      break;
    }
  }

  // Parse description for structured contact info
  const phoneMatch = description.match(/(?:phone|tel|contact)[:\s]*([+\d()\s-]{10,})/i);
  const emailMatch = description.match(/(?:email)[:\s]*([^\s]+@[^\s]+)/i);
  const guestsMatch = description.match(/(?:guests|people|pax)[:\s]*(\d+)/i);

  if (phoneMatch) contact.phone = phoneMatch[1].trim();
  if (emailMatch) contact.email = emailMatch[1].trim();
  if (guestsMatch && !contact.guests) contact.guests = guestsMatch[1].trim();

  // Also check description for "Client's phone number" / "Client's email" patterns
  const clientPhoneMatch = description.match(/Client['']s phone number[:\s]*([+\d()\s-]{10,})/i);
  const clientEmailMatch = description.match(/Client['']s email[:\s]*([^\s]+@[^\s]+)/i);
  if (clientPhoneMatch) contact.phone = clientPhoneMatch[1].trim();
  if (clientEmailMatch) contact.email = clientEmailMatch[1].trim();

  // Get email from attendees (skip the management email)
  if (!contact.email && attendees.length > 0) {
    const externalAttendee = attendees.find(a =>
      a.email && !a.email.includes('thequarrystl.com') && !a.organizer
    );
    if (externalAttendee) {
      contact.email = externalAttendee.email;
      if (!contact.name && externalAttendee.displayName) {
        contact.name = externalAttendee.displayName;
      }
    }
  }

  return contact;
}
