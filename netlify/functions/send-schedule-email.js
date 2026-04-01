const https = require('https');
const crypto = require('crypto');

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

// AWS SigV4 signing helper
const signRequest = (method, host, path, payload, accessKeyId, secretAccessKey, region) => {
  const service = 'ses';
  const algorithm = 'AWS4-HMAC-SHA256';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = now.toISOString().split('T')[0].replace(/-/g, '');

  const canonicalUri = path;
  const canonicalQueryString = '';
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';

  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = [method, canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

  const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();

  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Authorization': authorizationHeader,
    'X-Amz-Date': amzDate,
    'Content-Type': 'application/x-amz-json-1.1',
    'Host': host,
  };
};

// Send email via SES
const sendEmail = (toEmail, subject, htmlBody, accessKeyId, secretAccessKey, region) => {
  return new Promise((resolve, reject) => {
    const fromEmail = 'management@thequarrystl.com';
    const host = `email.${region}.amazonaws.com`;

    const payload = JSON.stringify({
      Source: fromEmail,
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
            Data: htmlBody,
            Charset: 'UTF-8',
          },
        },
      },
    });

    const headers = signRequest('POST', host, '/', payload, accessKeyId, secretAccessKey, region);

    const options = {
      hostname: host,
      path: '/',
      method: 'POST',
      headers,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ success: true, messageId: body });
        } else {
          reject(new Error(`SES error: ${res.statusCode} - ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
};

// Generate HTML email body
const generateEmailBody = (employeeName, weekOf, newShifts, oldShifts) => {
  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  let shiftsHtml = '<table style="width: 100%; border-collapse: collapse; margin-top: 15px;">';
  shiftsHtml += '<tr style="background-color: #f5f5f5;"><th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Date</th><th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Time</th><th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Changes</th></tr>';

  for (let i = 0; i < newShifts.length; i++) {
    const newShift = newShifts[i];
    const oldShift = oldShifts ? oldShifts[i] : null;
    const isChanged = oldShift && JSON.stringify(newShift) !== JSON.stringify(oldShift);
    const highlight = isChanged ? 'background-color: #fff3cd;' : '';

    shiftsHtml += `<tr style="${highlight}"><td style="border: 1px solid #ddd; padding: 10px;">${formatDate(newShift.date)}</td>`;
    shiftsHtml += `<td style="border: 1px solid #ddd; padding: 10px;">${newShift.startTime} - ${newShift.endTime}</td>`;
    shiftsHtml += `<td style="border: 1px solid #ddd; padding: 10px;">${isChanged ? '✓ Updated' : '-'}</td></tr>`;
  }

  shiftsHtml += '</table>';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #2c3e50; color: white; padding: 20px; text-align: center; }
        .content { background-color: #f9f9f9; padding: 20px; }
        .footer { text-align: center; color: #999; font-size: 12px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Your Schedule Has Been Updated</h1>
        </div>
        <div class="content">
          <p>Hi ${employeeName},</p>
          <p>Your work schedule for the week of <strong>${formatDate(weekOf)}</strong> has been updated. Please review your new schedule below:</p>
          ${shiftsHtml}
          <p style="margin-top: 20px;">If you have any questions or concerns about your schedule, please contact management.</p>
          <p>Thank you,<br>Quarry Management</p>
        </div>
        <div class="footer">
          <p>This is an automated message from the Quarry Scheduling System</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return html;
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });

  const accessKeyId = process.env.SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY;
  const region = process.env.SES_REGION || 'us-east-1';

  if (!accessKeyId || !secretAccessKey) {
    return response(500, { error: 'SES credentials not configured on server' });
  }

  try {
    const body = JSON.parse(event.body);
    const changes = body.changes || [];

    if (!Array.isArray(changes) || changes.length === 0) {
      return response(400, { error: 'changes array required with at least one change' });
    }

    const results = [];

    for (const change of changes) {
      const { employeeName, employeeEmail, weekOf, newShifts, oldShifts } = change;

      if (!employeeEmail || !employeeName || !weekOf || !newShifts) {
        results.push({
          email: employeeEmail || 'unknown',
          success: false,
          error: 'Missing required fields',
        });
        continue;
      }

      try {
        const subject = `Your Quarry Schedule Has Been Updated - Week of ${new Date(weekOf).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        const htmlBody = generateEmailBody(employeeName, weekOf, newShifts, oldShifts);

        await sendEmail(employeeEmail, subject, htmlBody, accessKeyId, secretAccessKey, region);

        results.push({
          email: employeeEmail,
          success: true,
        });
      } catch (err) {
        console.error(`Error sending email to ${employeeEmail}:`, err);
        results.push({
          email: employeeEmail,
          success: false,
          error: err.message,
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    return response(200, {
      success: successCount === changes.length,
      message: `Sent ${successCount} of ${changes.length} emails`,
      results,
    });
  } catch (err) {
    console.error('Send schedule email error:', err);
    return response(500, { error: err.message || 'Internal server error' });
  }
};
