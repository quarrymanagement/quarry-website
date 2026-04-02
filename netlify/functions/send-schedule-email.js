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

const signRequest = (method, host, path, payload, accessKeyId, secretAccessKey, region) => {
  const service = 'ses';
  const algorithm = 'AWS4-HMAC-SHA256';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = now.toISOString().split('T')[0].replace(/-/g, '');
  const canonicalUri = path;
  const canonicalHeaders = `content-type:application/x-amz-json-1.0\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:SimpleEmailService.SendEmail\n`;
  const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    'Authorization': `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Target': 'SimpleEmailService.SendEmail',
    'Content-Type': 'application/x-amz-json-1.0',
    'Host': host,
  };
};

const sendEmail = (toEmail, subject, htmlBody, accessKeyId, secretAccessKey, region) => {
  return new Promise((resolve, reject) => {
    const fromEmail = 'management@thequarrystl.com';
    const host = `email.${region}.amazonaws.com`;
    const payload = JSON.stringify({
      Source: fromEmail,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Html: { Data: htmlBody, Charset: 'UTF-8' } },
      },
    });
    const headers = signRequest('POST', host, '/', payload, accessKeyId, secretAccessKey, region);
    const req = https.request({ hostname: host, path: '/', method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve({ success: true });
        else reject(new Error(`SES error: ${res.statusCode} - ${body}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
};

const dayLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const dayKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// Build full schedule HTML table grouped by role
const buildFullScheduleHtml = (weekOf, allShifts, employees) => {
  const roles = ['Bartender', 'Server', 'Busser/Host', 'Kitchen'];
  const empMap = {};
  employees.forEach(e => { empMap[e.id] = e; });

  let html = '<table style="width:100%;border-collapse:collapse;margin:15px 0;font-size:13px;">';
  html += '<tr style="background:#2c3e50;color:#fff;">';
  html += '<th style="border:1px solid #ddd;padding:8px;text-align:left;">Employee</th>';
  dayLabels.forEach(d => { html += `<th style="border:1px solid #ddd;padding:8px;text-align:center;">${d}</th>`; });
  html += '</tr>';

  roles.forEach(role => {
    // Find employees in this role who have at least one shift
    const roleEmps = [];
    Object.keys(allShifts).forEach(eid => {
      const emp = empMap[eid];
      if (!emp || emp.primaryRole !== role) return;
      const hasShift = dayKeys.some(dk => allShifts[eid]?.[dk]?.role);
      if (hasShift) roleEmps.push(eid);
    });
    if (roleEmps.length === 0) return;

    // Role header
    html += `<tr style="background:#c8a84e;color:#fff;"><td colspan="8" style="border:1px solid #ddd;padding:8px;font-weight:bold;">${role}</td></tr>`;

    roleEmps.forEach(eid => {
      const emp = empMap[eid];
      const name = emp ? (emp.name || emp.firstName || 'Unknown') : 'Unknown';
      html += '<tr>';
      html += `<td style="border:1px solid #ddd;padding:6px 8px;font-weight:500;background:#f8f8f8;">${name}</td>`;
      dayKeys.forEach(dk => {
        const shift = allShifts[eid]?.[dk];
        if (shift && shift.role) {
          html += `<td style="border:1px solid #ddd;padding:6px;text-align:center;font-size:12px;">${shift.display || shift.role}</td>`;
        } else {
          html += '<td style="border:1px solid #ddd;padding:6px;text-align:center;color:#ccc;">-</td>';
        }
      });
      html += '</tr>';
    });
  });

  html += '</table>';
  return html;
};

// Build individual shift table for one employee
const buildMyShiftsHtml = (empId, allShifts, weekStart) => {
  const shifts = allShifts[empId] || {};
  let html = '<table style="width:100%;border-collapse:collapse;margin:15px 0;">';
  html += '<tr style="background:#c8a84e;color:#fff;">';
  html += '<th style="border:1px solid #ddd;padding:10px;text-align:left;">Day</th>';
  html += '<th style="border:1px solid #ddd;padding:10px;text-align:left;">Shift</th>';
  html += '</tr>';

  const startDate = new Date(weekStart + 'T12:00:00');
  dayKeys.forEach((dk, i) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const shift = shifts[dk];
    const display = (shift && shift.role) ? (shift.display || `${shift.role} ${shift.startTime}-${shift.endTime}`) : 'OFF';
    const bg = (shift && shift.role) ? '#fff' : '#f5f5f5';
    const color = (shift && shift.role) ? '#333' : '#999';
    html += `<tr style="background:${bg};"><td style="border:1px solid #ddd;padding:10px;">${dateStr}</td>`;
    html += `<td style="border:1px solid #ddd;padding:10px;color:${color};font-weight:${shift && shift.role ? '500' : 'normal'};">${display}</td></tr>`;
  });

  html += '</table>';
  return html;
};

const generateEmailBody = (employeeName, weekOf, empId, allShifts, employees) => {
  const startDate = new Date(weekOf + 'T12:00:00');
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 6);
  const weekLabel = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' - ' + endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const myShiftsHtml = buildMyShiftsHtml(empId, allShifts, weekOf);
  const fullScheduleHtml = buildFullScheduleHtml(weekOf, allShifts, employees);

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;color:#333;line-height:1.6;margin:0;padding:0;">
<div style="max-width:700px;margin:0 auto;">
  <div style="background:#1a1a2e;padding:25px;text-align:center;">
    <h1 style="color:#c8a84e;margin:0;font-size:22px;">The Quarry - Weekly Schedule</h1>
    <p style="color:#aaa;margin:5px 0 0;font-size:14px;">Week of ${weekLabel}</p>
  </div>
  <div style="padding:25px;background:#fff;">
    <p style="font-size:16px;">Hi <strong>${employeeName}</strong>,</p>
    <p>Here is your schedule for the upcoming week. Please review your shifts below.</p>

    <h2 style="color:#c8a84e;font-size:18px;border-bottom:2px solid #c8a84e;padding-bottom:6px;margin-top:25px;">Your Shifts</h2>
    ${myShiftsHtml}

    <h2 style="color:#c8a84e;font-size:18px;border-bottom:2px solid #c8a84e;padding-bottom:6px;margin-top:30px;">Full Team Schedule</h2>
    <p style="font-size:13px;color:#666;">Here is the complete team schedule for the week:</p>
    ${fullScheduleHtml}

    <p style="margin-top:25px;font-size:14px;">If you have any questions or need to request changes, please contact management.</p>
    <p style="font-size:14px;">Thank you,<br><strong>Quarry Management</strong></p>
  </div>
  <div style="text-align:center;color:#999;font-size:11px;padding:15px;background:#f5f5f5;">
    <p style="margin:0;">This is an automated message from The Quarry Scheduling System</p>
    <p style="margin:4px 0 0;">View your schedule anytime at <a href="https://thequarrystl.com/employee" style="color:#c8a84e;">thequarrystl.com/employee</a></p>
  </div>
</div></body></html>`;
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
    const { weekOf, allShifts, employees: empList } = body;

    if (!weekOf || !allShifts || !empList) {
      return response(400, { error: 'weekOf, allShifts, and employees are required' });
    }

    const results = [];
    const startDate = new Date(weekOf + 'T12:00:00');
    const weekLabel = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    for (const emp of empList) {
      if (!emp.email || !emp.email.includes('@')) {
        results.push({ email: emp.email || 'none', success: false, error: 'No valid email' });
        continue;
      }

      try {
        const name = emp.name || emp.firstName || 'Team Member';
        const subject = `Your Quarry Schedule - Week of ${weekLabel}`;
        const htmlBody = generateEmailBody(name, weekOf, emp.id, allShifts, empList);
        await sendEmail(emp.email, subject, htmlBody, accessKeyId, secretAccessKey, region);
        results.push({ email: emp.email, success: true });
      } catch (err) {
        console.error(`Error sending to ${emp.email}:`, err);
        results.push({ email: emp.email, success: false, error: err.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    return response(200, {
      success: true,
      message: `Sent ${successCount} of ${empList.length} emails`,
      results,
    });
  } catch (err) {
    console.error('Send schedule email error:', err);
    return response(500, { error: err.message || 'Internal server error' });
  }
};
