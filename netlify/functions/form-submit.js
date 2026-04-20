const https = require('https');
const AWS = require('aws-sdk');

const ses = new AWS.SES({
  region: process.env.SES_REGION || 'us-east-1',
  accessKeyId: process.env.SES_ACCESS_KEY_ID,
  secretAccessKey: process.env.SES_SECRET_ACCESS_KEY,
});

function sendEmail(to, subject, htmlBody) {
  return ses.sendEmail({
    Source: 'The Quarry STL <management@thequarrystl.com>',
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Html: { Data: htmlBody, Charset: 'UTF-8' } },
    },
  }).promise();
}

function githubRequest(method, path, token, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'Quarry-Forms',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ statusCode: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body);
    const { formId, responses, files } = body;
    // responses = { fieldId: value, ... }
    // files = { fieldId: { name, type, data (base64) }, ... }

    if (!formId || !responses) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing formId or responses' }) };
    }

    const ghToken = process.env.GITHUB_TOKEN;
    const repo = 'quarrymanagement/quarry-website';

    // Load forms.json to get form definition
    let formsData;
    try {
      const raw = await fetchRaw('https://raw.githubusercontent.com/' + repo + '/main/forms.json');
      formsData = JSON.parse(raw);
    } catch (e) {
      formsData = { forms: [], submissions: {} };
    }

    const form = (formsData.forms || []).find(f => f.id === formId);
    if (!form) {
      return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Form not found' }) };
    }

    if (form.status === 'closed') {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'This form is no longer accepting submissions.' }) };
    }

    // Validate required fields
    for (var i = 0; i < form.fields.length; i++) {
      var field = form.fields[i];
      if (field.required && !responses[field.id] && !(files && files[field.id])) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: field.label + ' is required.' }) };
      }
    }

    // Build submission record
    const submission = {
      id: 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      formId: formId,
      formName: form.name,
      eventId: form.eventId || null,
      responses: responses,
      fileNames: {},
      status: 'pending',
      created: new Date().toISOString(),
      notes: ''
    };

    // Handle file references (store file names, base64 data stays in submission)
    if (files) {
      Object.keys(files).forEach(function(fieldId) {
        var f = files[fieldId];
        submission.fileNames[fieldId] = f.name || 'upload';
        submission.responses[fieldId] = '[File: ' + (f.name || 'upload') + ']';
      });
      submission.files = files;
    }

    // Save submission to forms.json
    if (!formsData.submissions) formsData.submissions = {};
    if (!formsData.submissions[formId]) formsData.submissions[formId] = [];
    formsData.submissions[formId].push(submission);

    // Update submission count on form
    if (form) {
      form.submissionCount = (formsData.submissions[formId] || []).length;
    }

    // Get SHA and push
    const metaRes = await githubRequest('GET', '/repos/' + repo + '/contents/forms.json', ghToken);
    const fileSha = (metaRes.statusCode === 200 && metaRes.data.sha) ? metaRes.data.sha : '';

    const encoded = Buffer.from(JSON.stringify(formsData, null, 2), 'utf-8').toString('base64');
    const putData = {
      message: 'Form submission: ' + form.name + ' — ' + (responses.email || responses[Object.keys(responses)[0]] || 'Anonymous'),
      content: encoded,
    };
    if (fileSha) putData.sha = fileSha;

    const putRes = await githubRequest('PUT', '/repos/' + repo + '/contents/forms.json', ghToken, putData);
    if (putRes.statusCode !== 200 && putRes.statusCode !== 201) {
      console.error('GitHub save failed:', putRes.statusCode, JSON.stringify(putRes.data).substring(0, 200));
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Failed to save submission' }) };
    }

    // Build email content from responses
    var emailRows = '';
    form.fields.forEach(function(field) {
      var val = responses[field.id] || '(empty)';
      emailRows += '<p style="margin:6px 0"><strong>' + field.label + ':</strong> ' + val + '</p>';
    });

    var eventNote = form.eventId ? '<p style="color:#888;font-size:0.85em">Linked to event: ' + (form.eventName || form.eventId) + '</p>' : '';

    // Send owner notification
    try {
      await sendEmail('management@thequarrystl.com', 'New Form Submission — ' + form.name,
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
        '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
        '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
        '<div style="padding:32px 24px;background:#FFFFFF">' +
        '<h2 style="color:#2C1A0E;margin-top:0">New Submission: ' + form.name + '</h2>' +
        eventNote +
        '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px">' +
        emailRows +
        '</div>' +
        '<p style="color:#444">View and manage this submission in your <a href="https://thequarrystl.com/admin/#forms" style="color:#B8933A">admin panel</a>.</p>' +
        '</div></div>'
      );
    } catch (e) {
      console.error('Owner email error:', e.message);
    }

    // Send confirmation to submitter if there's an email field
    var submitterEmail = null;
    form.fields.forEach(function(field) {
      if (field.type === 'email' && responses[field.id]) {
        submitterEmail = responses[field.id];
      }
    });

    if (submitterEmail) {
      try {
        await sendEmail(submitterEmail, 'Submission Received — ' + form.name,
          '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
          '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
          '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
          '<div style="padding:32px 24px;background:#FFFFFF">' +
          '<h2 style="color:#2C1A0E;margin-top:0">We\'ve Received Your Submission</h2>' +
          '<p style="color:#444">Thank you for your interest! We\'ve received your submission for <strong>' + form.name + '</strong> and will review it shortly.</p>' +
          '<p style="color:#444">If you have any questions, call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email <a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p>' +
          '</div></div>'
        );
      } catch (e) {
        console.error('Submitter email error:', e.message);
      }
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, message: 'Submission received!' }) };

  } catch (err) {
    console.error('Form submit error:', err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
