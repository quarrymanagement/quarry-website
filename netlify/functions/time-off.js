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

// Generate unique request ID
const generateRequestId = () => {
  return `timeoff-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
};

// Handle request action
const handleRequest = async (body, token) => {
  const { employeeId, dates, reason } = body;
  if (!employeeId || !dates || !Array.isArray(dates) || dates.length === 0) {
    return response(400, { error: 'employeeId, dates array, and reason required' });
  }

  try {
    // Fetch schedule.json
    const shaRes = await githubRequest('GET', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token);
    if (shaRes.statusCode !== 200) {
      return response(500, { error: 'Could not fetch schedule data' });
    }

    const scheduleContent = Buffer.from(shaRes.data.content, 'base64').toString('utf-8');
    const scheduleData = JSON.parse(scheduleContent);
    const sha = shaRes.data.sha;

    if (!scheduleData.timeOffRequests) {
      scheduleData.timeOffRequests = [];
    }

    // Create new time off request
    const requestId = generateRequestId();
    const newRequest = {
      id: requestId,
      employeeId,
      dates,
      reason: reason || '',
      status: 'pending',
      requestedAt: new Date().toISOString(),
    };

    scheduleData.timeOffRequests.push(newRequest);

    // Save back to GitHub
    const updatedContent = JSON.stringify(scheduleData, null, 2);
    const encoded = Buffer.from(updatedContent, 'utf-8').toString('base64');

    const putData = {
      message: 'Add time-off request',
      content: encoded,
      sha,
    };

    const putRes = await githubRequest('PUT', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token, putData);

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      return response(200, {
        success: true,
        message: 'Time-off request submitted',
        requestId,
      });
    } else {
      return response(putRes.statusCode, { error: 'Failed to save time-off request' });
    }
  } catch (err) {
    console.error('Time-off request error:', err);
    return response(500, { error: 'Internal server error' });
  }
};

// Handle approve action
const handleApprove = async (body, token) => {
  const { requestId } = body;
  if (!requestId) {
    return response(400, { error: 'requestId required' });
  }

  try {
    // Fetch schedule.json
    const shaRes = await githubRequest('GET', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token);
    if (shaRes.statusCode !== 200) {
      return response(500, { error: 'Could not fetch schedule data' });
    }

    const scheduleContent = Buffer.from(shaRes.data.content, 'base64').toString('utf-8');
    const scheduleData = JSON.parse(scheduleContent);
    const sha = shaRes.data.sha;

    if (!scheduleData.timeOffRequests) {
      scheduleData.timeOffRequests = [];
    }

    // Find and update request
    const request = scheduleData.timeOffRequests.find(r => r.id === requestId);
    if (!request) {
      return response(404, { error: 'Request not found' });
    }

    request.status = 'approved';
    request.approvedAt = new Date().toISOString();

    // Save back to GitHub
    const updatedContent = JSON.stringify(scheduleData, null, 2);
    const encoded = Buffer.from(updatedContent, 'utf-8').toString('base64');

    const putData = {
      message: 'Approve time-off request',
      content: encoded,
      sha,
    };

    const putRes = await githubRequest('PUT', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token, putData);

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      return response(200, {
        success: true,
        message: 'Time-off request approved',
      });
    } else {
      return response(putRes.statusCode, { error: 'Failed to approve request' });
    }
  } catch (err) {
    console.error('Approve request error:', err);
    return response(500, { error: 'Internal server error' });
  }
};

// Handle deny action
const handleDeny = async (body, token) => {
  const { requestId, reason } = body;
  if (!requestId) {
    return response(400, { error: 'requestId required' });
  }

  try {
    // Fetch schedule.json
    const shaRes = await githubRequest('GET', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token);
    if (shaRes.statusCode !== 200) {
      return response(500, { error: 'Could not fetch schedule data' });
    }

    const scheduleContent = Buffer.from(shaRes.data.content, 'base64').toString('utf-8');
    const scheduleData = JSON.parse(scheduleContent);
    const sha = shaRes.data.sha;

    if (!scheduleData.timeOffRequests) {
      scheduleData.timeOffRequests = [];
    }

    // Find and update request
    const request = scheduleData.timeOffRequests.find(r => r.id === requestId);
    if (!request) {
      return response(404, { error: 'Request not found' });
    }

    request.status = 'denied';
    request.denialReason = reason || '';
    request.deniedAt = new Date().toISOString();

    // Save back to GitHub
    const updatedContent = JSON.stringify(scheduleData, null, 2);
    const encoded = Buffer.from(updatedContent, 'utf-8').toString('base64');

    const putData = {
      message: 'Deny time-off request',
      content: encoded,
      sha,
    };

    const putRes = await githubRequest('PUT', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token, putData);

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      return response(200, {
        success: true,
        message: 'Time-off request denied',
      });
    } else {
      return response(putRes.statusCode, { error: 'Failed to deny request' });
    }
  } catch (err) {
    console.error('Deny request error:', err);
    return response(500, { error: 'Internal server error' });
  }
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return response(500, { error: 'GitHub token not configured on server' });
  }

  try {
    const body = JSON.parse(event.body);
    const action = body.action;

    switch (action) {
      case 'request':
        return await handleRequest(body, token);
      case 'approve':
        return await handleApprove(body, token);
      case 'deny':
        return await handleDeny(body, token);
      default:
        return response(400, { error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Time-off error:', err);
    return response(500, { error: err.message || 'Internal server error' });
  }
};
