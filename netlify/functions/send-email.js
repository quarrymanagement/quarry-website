const AWS = require('aws-sdk');

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

// Initialize AWS SES
const ses = new AWS.SES({
  region: process.env.SES_REGION || 'us-east-1',
  accessKeyId: process.env.SES_ACCESS_KEY_ID,
  secretAccessKey: process.env.SES_SECRET_ACCESS_KEY,
});

// Replace merge tags in template
const replaceMergeTags = (htmlBody, recipientData) => {
  let result = htmlBody;
  result = result.replace(/{firstName}/g, recipientData.firstName || '');
  result = result.replace(/{lastName}/g, recipientData.lastName || '');
  result = result.replace(/{email}/g, recipientData.email || '');
  return result;
};

// Send individual email via SES
const sendOneEmail = (params) => {
  return new Promise((resolve, reject) => {
    ses.sendEmail(params, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
};

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

        const emailParams = {
          Source: `${fromName} <${fromEmail}>`,
          Destination: { ToAddresses: [recipient.email] },
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Html: { Data: personalizedHtml, Charset: 'UTF-8' } },
          },
        };

        await sendOneEmail(emailParams);
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
