const AWS = require('aws-sdk');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Helper to send CORS-compliant responses
const response = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

// Handle preflight requests
const handleOptions = () => response(200, { message: 'OK' });

// Initialize AWS SES
const ses = new AWS.SES({
  region: process.env.AWS_SES_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// Replace merge tags in template
const replaceMergeTags = (htmlBody, recipientData) => {
  let result = htmlBody;

  if (recipientData.firstName) {
    result = result.replace(/{firstName}/g, recipientData.firstName);
  } else {
    result = result.replace(/{firstName}/g, '');
  }

  if (recipientData.lastName) {
    result = result.replace(/{lastName}/g, recipientData.lastName);
  } else {
    result = result.replace(/{lastName}/g, '');
  }

  if (recipientData.email) {
    result = result.replace(/{email}/g, recipientData.email);
  } else {
    result = result.replace(/{email}/g, '');
  }

  return result;
};

// Send individual email
const sendEmail = (ses, params) => {
  return new Promise((resolve, reject) => {
    ses.sendEmail(params, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
};

// Main handler
exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return handleOptions();
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return response(405, { success: false, error: 'Method not allowed. Use POST.' });
  }

  try {
    const body = JSON.parse(event.body);
    const {
      to,
      subject,
      htmlBody,
      fromEmail = 'management@thequarrystl.com',
      fromName = 'The Quarry',
      recipients,
    } = body;

    // Validate required fields
    if (!to || !Array.isArray(to) || to.length === 0) {
      return response(400, {
        success: false,
        error: 'Missing or invalid required field: to (must be an array of email addresses)',
      });
    }

    if (!subject) {
      return response(400, {
        success: false,
        error: 'Missing required field: subject',
      });
    }

    if (!htmlBody) {
      return response(400, {
        success: false,
        error: 'Missing required field: htmlBody',
      });
    }

    // Create a map of recipient data by email for merge tags
    const recipientMap = {};
    if (recipients && Array.isArray(recipients)) {
      recipients.forEach((recipient) => {
        recipientMap[recipient.email] = recipient;
      });
    }

    let sentCount = 0;
    let failedCount = 0;
    const errors = [];

    // Send email to each recipient individually to support merge tags
    for (const toEmail of to) {
      try {
        const recipientData = recipientMap[toEmail] || { email: toEmail };
        const personalizedHtmlBody = replaceMergeTags(htmlBody, recipientData);

        const emailParams = {
          Source: `${fromName} <${fromEmail}>`,
          Destination: {
            ToAddresses: [toEmail],
          },
          Message: {
            Subject: {
              Data: subject,
              Charset: 'UTF-8',
            },
            Body: {
              Html: {
                Data: personalizedHtmlBody,
                Charset: 'UTF-8',
              },
            },
          },
        };

        await sendEmail(ses, emailParams);
        sentCount++;
      } catch (error) {
        console.error(`Failed to send email to ${toEmail}:`, error);
        failedCount++;
        errors.push({
          email: toEmail,
          error: error.message,
        });
      }
    }

    return response(200, {
      success: true,
      sent: sentCount,
      failed: failedCount,
      total: to.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Error sending emails:', error);
    return response(500, {
      success: false,
      error: error.message,
    });
  }
};
