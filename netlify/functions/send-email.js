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

// Replace merge tags in template
const replaceMergeTags = (htmlBody, recipientData) => {
  let result = htmlBody;
  result = result.replace(/{firstName}/g, recipientData.firstName || '');
  result = result.replace(/{lastName}/g, recipientData.lastName || '');
  result = result.replace(/{email}/g, recipientData.email || '');
  return result;
};

// Send individual email via SendGrid
function sendGridEmail(to, subject, htmlBody, fromEmail, fromName) {
  fromEmail = fromEmail || 'management@thequarrystl.com';
  fromName = fromName || 'The Quarry STL';
  var toArray = Array.isArray(to) ? to : [to];
  var payload = JSON.stringify({
    personalizations: [{ to: toArray.map(function(email) { return { email: email }; }) }],
    from: { email: fromEmail, name: fromName },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
  });

  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY,
        'Content-Type': 'application/json',
      },
    }, function(res) {
      var body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
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
      recipientList = recipients.map(r => ({
        email: r.email,
        firstName: r.firstName || '',
        lastName: r.lastName || '',
      }));
    } else if (to && Array.isArray(to) && to.length > 0) {
      recipientList = to.map(email => ({ email, firstName: '', lastName: '' }));
    }

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

    let sentCount = 0;
    let failedCount = 0;
    const errors = [];

    // Send to each recipient individually (supports merge tags)
    for (const recipient of recipientList) {
      try {
        const personalizedHtml = replaceMergeTags(htmlBody, recipient);

        await sendGridEmail(recipient.email, subject, personalizedHtml, fromEmail, fromName);
        sentCount++;
      } catch (error) {
        console.error(`Failed to send to ${recipient.email}:`, error.message);
        failedCount++;
        errors.push({ email: recipient.email, error: error.message });
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
