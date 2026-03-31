const https = require('https');

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

// GitHub API helper - make HTTPS request
const githubRequest = (method, path, data = null) => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path,
      method,
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
        'User-Agent': 'Netlify-Function',
        Accept: 'application/vnd.github.v3+json',
      },
    };

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const parsedData = JSON.parse(responseData);
          resolve({
            statusCode: res.statusCode,
            data: parsedData,
          });
        } catch (error) {
          resolve({
            statusCode: res.statusCode,
            data: responseData,
          });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
};

// Fetch CRM notes from GitHub
const fetchCrmNotes = async () => {
  try {
    const result = await githubRequest(
      'GET',
      '/repos/quarrymanagement/quarry-website/contents/crm-notes.json'
    );

    if (result.statusCode === 404) {
      // File doesn't exist yet
      return [];
    }

    if (result.statusCode !== 200) {
      throw new Error(`GitHub API error: ${result.statusCode}`);
    }

    const content = Buffer.from(result.data.content, 'base64').toString('utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error fetching CRM notes:', error);
    // Return empty array if file doesn't exist or error occurs
    if (error.message.includes('404')) {
      return [];
    }
    throw error;
  }
};

// Save CRM notes to GitHub
const saveCrmNotes = async (notes, currentSha = null) => {
  try {
    const content = Buffer.from(JSON.stringify(notes, null, 2)).toString('base64');

    // Get current file SHA if not provided
    let sha = currentSha;
    if (!sha) {
      const result = await githubRequest(
        'GET',
        '/repos/quarrymanagement/quarry-website/contents/crm-notes.json'
      );

      if (result.statusCode === 200) {
        sha = result.data.sha;
      }
    }

    const updateData = {
      message: `Update CRM notes: ${new Date().toISOString()}`,
      content,
      ...(sha && { sha }),
    };

    const result = await githubRequest(
      'PUT',
      '/repos/quarrymanagement/quarry-website/contents/crm-notes.json',
      updateData
    );

    if (result.statusCode !== 200 && result.statusCode !== 201) {
      throw new Error(`GitHub API error: ${result.statusCode} - ${result.data.message || ''}`);
    }

    return result.data;
  } catch (error) {
    console.error('Error saving CRM notes:', error);
    throw error;
  }
};

// GET: Load all CRM notes
const getCrmNotes = async (event) => {
  try {
    const notes = await fetchCrmNotes();

    return response(200, {
      success: true,
      data: notes,
      count: notes.length,
    });
  } catch (error) {
    console.error('Error getting CRM notes:', error);
    return response(500, {
      success: false,
      error: error.message,
    });
  }
};

// POST: Save a new CRM note
const saveCrmNote = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { contactEmail, note, timestamp } = body;

    if (!contactEmail || !note) {
      return response(400, {
        success: false,
        error: 'Missing required fields: contactEmail, note',
      });
    }

    // Fetch current notes
    const notes = await fetchCrmNotes();

    // Add new note
    const newNote = {
      id: `note_${Date.now()}`,
      contactEmail,
      note,
      timestamp: timestamp || new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    notes.push(newNote);

    // Save back to GitHub
    await saveCrmNotes(notes);

    return response(200, {
      success: true,
      message: 'Note saved successfully',
      note: newNote,
    });
  } catch (error) {
    console.error('Error saving CRM note:', error);
    return response(500, {
      success: false,
      error: error.message,
    });
  }
};

// Main handler
exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return handleOptions();
  }

  // Verify GitHub token is configured
  if (!process.env.GITHUB_TOKEN) {
    return response(500, {
      success: false,
      error: 'GitHub token not configured in environment variables',
    });
  }

  try {
    if (event.httpMethod === 'GET') {
      return await getCrmNotes(event);
    } else if (event.httpMethod === 'POST') {
      return await saveCrmNote(event);
    } else {
      return response(405, {
        success: false,
        error: 'Method not allowed. Use GET or POST.',
      });
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    return response(500, {
      success: false,
      error: 'Internal server error',
    });
  }
};
