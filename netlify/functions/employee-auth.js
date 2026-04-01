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

// Hash password with salt
const hashPassword = (password, salt = null) => {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
  return `${salt}:${hash}`;
};

// Verify password
const verifyPassword = (password, storedHash) => {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const testHash = crypto.createHash('sha256').update(salt + password).digest('hex');
  return testHash === hash;
};

// Generate session token
const generateToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Handle login action
const handleLogin = async (body, token) => {
  const { email, password } = body;
  if (!email || !password) {
    return response(400, { error: 'Email and password required' });
  }

  try {
    // Fetch schedule.json to get employees list
    const res = await githubRequest('GET', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token);

    if (res.statusCode !== 200) {
      return response(500, { error: 'Could not fetch employee data' });
    }

    const scheduleContent = Buffer.from(res.data.content, 'base64').toString('utf-8');
    const scheduleData = JSON.parse(scheduleContent);
    const employees = scheduleData.employees || [];

    // Find employee by email
    const employee = employees.find(emp => emp.email && emp.email.toLowerCase() === email.toLowerCase());
    if (!employee) {
      return response(401, { error: 'Invalid email or password' });
    }

    // Verify password
    if (!employee.passwordHash || !verifyPassword(password, employee.passwordHash)) {
      return response(401, { error: 'Invalid email or password' });
    }

    // Generate session token
    const sessionToken = generateToken();

    return response(200, {
      success: true,
      employee: {
        id: employee.id,
        name: employee.name,
        email: employee.email,
        primaryRole: employee.primaryRole,
      },
      token: sessionToken,
    });
  } catch (err) {
    console.error('Login error:', err);
    return response(500, { error: 'Internal server error' });
  }
};

// Handle change password action
const handleChangePassword = async (body, token) => {
  const { employeeId, oldPassword, newPassword } = body;
  if (!employeeId || !oldPassword || !newPassword) {
    return response(400, { error: 'employeeId, oldPassword, and newPassword required' });
  }

  try {
    // Fetch schedule.json
    const shaRes = await githubRequest('GET', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token);
    if (shaRes.statusCode !== 200) {
      return response(500, { error: 'Could not fetch employee data' });
    }

    const scheduleContent = Buffer.from(shaRes.data.content, 'base64').toString('utf-8');
    const scheduleData = JSON.parse(scheduleContent);
    const employees = scheduleData.employees || [];
    const sha = shaRes.data.sha;

    // Find employee
    const employee = employees.find(emp => emp.id === employeeId);
    if (!employee) {
      return response(404, { error: 'Employee not found' });
    }

    // Verify old password
    if (!employee.passwordHash || !verifyPassword(oldPassword, employee.passwordHash)) {
      return response(401, { error: 'Current password is incorrect' });
    }

    // Update password
    employee.passwordHash = hashPassword(newPassword);

    // Save back to GitHub
    const updatedContent = JSON.stringify(scheduleData, null, 2);
    const encoded = Buffer.from(updatedContent, 'utf-8').toString('base64');

    const putData = {
      message: 'Update employee password',
      content: encoded,
      sha,
    };

    const putRes = await githubRequest('PUT', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token, putData);

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      return response(200, { success: true, message: 'Password updated' });
    } else {
      return response(putRes.statusCode, { error: 'Failed to update password' });
    }
  } catch (err) {
    console.error('Change password error:', err);
    return response(500, { error: 'Internal server error' });
  }
};

// Handle register first time action
const handleRegisterFirstTime = async (body, token) => {
  const { email, password } = body;
  if (!email || !password) {
    return response(400, { error: 'Email and password required' });
  }

  try {
    // Fetch schedule.json
    const shaRes = await githubRequest('GET', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token);
    if (shaRes.statusCode !== 200) {
      return response(500, { error: 'Could not fetch employee data' });
    }

    const scheduleContent = Buffer.from(shaRes.data.content, 'base64').toString('utf-8');
    const scheduleData = JSON.parse(scheduleContent);
    const employees = scheduleData.employees || [];
    const sha = shaRes.data.sha;

    // Find employee by email
    const employee = employees.find(emp => emp.email && emp.email.toLowerCase() === email.toLowerCase());
    if (!employee) {
      return response(404, { error: 'Employee not found in system' });
    }

    // Check if already has password
    if (employee.passwordHash) {
      return response(400, { error: 'Employee already has a password set' });
    }

    // Set password
    employee.passwordHash = hashPassword(password);

    // Save back to GitHub
    const updatedContent = JSON.stringify(scheduleData, null, 2);
    const encoded = Buffer.from(updatedContent, 'utf-8').toString('base64');

    const putData = {
      message: 'Set employee password on first-time registration',
      content: encoded,
      sha,
    };

    const putRes = await githubRequest('PUT', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token, putData);

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      const sessionToken = generateToken();
      return response(200, {
        success: true,
        message: 'Password set successfully',
        token: sessionToken,
        employee: {
          id: employee.id,
          name: employee.name,
          email: employee.email,
          primaryRole: employee.primaryRole,
        },
      });
    } else {
      return response(putRes.statusCode, { error: 'Failed to set password' });
    }
  } catch (err) {
    console.error('Register first time error:', err);
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
      case 'login':
        return await handleLogin(body, token);
      case 'change-password':
        return await handleChangePassword(body, token);
      case 'register-first-time':
        return await handleRegisterFirstTime(body, token);
      default:
        return response(400, { error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Auth error:', err);
    return response(500, { error: err.message || 'Internal server error' });
  }
};
