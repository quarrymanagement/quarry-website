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

// GitHub API helper
const githubRequest = (method, path, token, data = null) => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'Quarry-Admin-Panel',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return response(500, { error: 'GitHub token not configured on server' });
  }

  try {
    const { employeeId, dates, reason } = JSON.parse(event.body);

    if (!employeeId || !dates || !dates.length || !reason) {
      return response(400, { error: 'Missing required fields: employeeId, dates, reason' });
    }

    const repo = 'quarrymanagement/quarry-website';
    const filePath = 'schedule.json';

    // Get current schedule.json
    const getRes = await githubRequest('GET', `/repos/${repo}/contents/${filePath}`, token);
    if (getRes.statusCode !== 200) {
      return response(500, { error: 'Could not read schedule data from GitHub' });
    }

    const sha = getRes.data.sha;
    const currentContent = Buffer.from(getRes.data.content, 'base64').toString('utf-8');
    const scheduleData = JSON.parse(currentContent);

    // Create the time-off request
    const newRequest = {
      id: 'to-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      employeeId,
      dates,
      reason,
      status: 'pending',
      requestedAt: new Date().toISOString(),
    };

    // Add to timeOffRequests array
    if (!scheduleData.timeOffRequests) {
      scheduleData.timeOffRequests = [];
    }
    scheduleData.timeOffRequests.push(newRequest);

    // Save back to GitHub
    const encoded = Buffer.from(JSON.stringify(scheduleData, null, 2), 'utf-8').toString('base64');
    const putRes = await githubRequest('PUT', `/repos/${repo}/contents/${filePath}`, token, {
      message: `Time-off request from ${employeeId}: ${dates[0]}${dates.length > 1 ? ' to ' + dates[dates.length - 1] : ''}`,
      content: encoded,
      sha,
    });

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      return response(200, { success: true, message: 'Time-off request submitted successfully', request: newRequest });
    } else {
      return response(putRes.statusCode, { error: putRes.data.message || 'GitHub save failed' });
    }
  } catch (err) {
    console.error('Request timeoff error:', err);
    return response(500, { error: err.message || 'Internal server error' });
  }
};
