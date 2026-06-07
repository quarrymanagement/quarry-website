const https = require('https');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const response = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

const handleOptions = () => response(200, { message: 'OK' });

// SendGrid bulk send with per-recipient personalization.
// One API call can carry up to 1000 personalizations — each with its own
// `to` and its own `substitutions` map (for merge tags like {firstName}).
// This is the difference between "sends in 1 second" and "times out at 10s".
function sendGridBulk(personalizations, subject, htmlBody, fromEmail, fromName) {
  fromEmail = fromEmail || 'management@thequarrystl.com';
  fromName = fromName || 'The Quarry STL';

  const payload = JSON.stringify({
    personalizations: personalizations,
    from: { email: fromEmail, name: fromName },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
  });

  return new Promise(function (resolve, reject) {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY,
        'Content-Type': 'application/json',
      },
    }, function (res) {
      let body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: body });
        } else {
          reject(new Error('SendGrid error ' + res.statusCode + ': ' + body));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Main handler
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') {
    return response(405, { success: false, error: 'Method not allowed. Use POST.' });
  }

  try {
    const body = JSON.parse(event.body);
    const {
      subject,
      htmlBody,
      fromEmail = 'management@thequarrystl.com',
      fromName = 'The Quarry STL',
      recipients, // Array of { email, firstName, lastName }
      to,         // Legacy: array of email strings
    } = body;

    // Build recipient list - support both formats
    let recipientList = [];
    if (recipients && Array.isArray(recipients) && recipients.length > 0) {
      recipientList = recipients
        .filter(r => r && r.email)
        .map(r => ({
          email: String(r.email).trim(),
          firstName: r.firstName || '',
          lastName: r.lastName || '',
        }));
    } else if (to && Array.isArray(to) && to.length > 0) {
      recipientList = to
        .filter(email => email)
        .map(email => ({ email: String(email).trim(), firstName: '', lastName: '' }));
    }

    // Deduplicate by email (case-insensitive) so we never send the same person twice
    const seen = new Set();
    recipientList = recipientList.filter(r => {
      const k = r.email.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (recipientList.length === 0) {
      return response(400, {
        success: false,
        error: 'Missing recipients. Provide "recipients" (array of {email, firstName, lastName}) or "to" (array of email strings).',
      });
    }

    if (!subject) {
      return response(400, { success: false, error: 'Missing required field: subject' });
    }

    if (!htmlBody) {
      return response(400, { success: false, error: 'Missing required field: htmlBody' });
    }

    // SendGrid v3 lets us put up to 1,000 personalizations in a SINGLE API call.
    // Each personalization can carry its own `substitutions` map — SendGrid
    // replaces those tokens in the subject + content at delivery time.
    // We use the same token format the legacy loop used: {firstName}, {lastName}, {email}.
    const BATCH_SIZE = 900; // stay under SendGrid's 1000 limit with a safety margin

    let sentCount = 0;
    let failedCount = 0;
    const errors = [];

    for (let i = 0; i < recipientList.length; i += BATCH_SIZE) {
      const chunk = recipientList.slice(i, i + BATCH_SIZE);
      const personalizations = chunk.map(r => ({
        to: [{ email: r.email }],
        substitutions: {
          '{firstName}': r.firstName || '',
          '{lastName}': r.lastName || '',
          '{email}': r.email || '',
        },
      }));

      try {
        await sendGridBulk(personalizations, subject, htmlBody, fromEmail, fromName);
        sentCount += chunk.length;
      } catch (error) {
        console.error('Batch send failed (' + i + '-' + (i + chunk.length) + '):', error.message);
        failedCount += chunk.length;
        // Record one error per failed batch (avoid blowing up the response payload)
        errors.push({
          batchStart: i,
          batchEnd: i + chunk.length,
          error: error.message,
        });
      }
    }

    return response(200, {
      success: true,
      sent: sentCount,
      failed: failedCount,
      total: recipientList.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Error sending emails:', error);
    return response(500, { success: false, error: error.message });
  }
};
