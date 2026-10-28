// Netlify event-triggered function: fires on every form submission
// Sends confirmation emails via SendGrid (the canonical email path for this site)
//
// Handles two forms so far:
//   - wine-club-registration  -> member confirmation + owner notification
//   - wedding-tour             -> couple confirmation + Jacqueline + management

const https = require('https');

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

async function sendEmail({ to, subject, html }) {
  if (!to) return;
  try {
    await sendGridEmail(to, subject, html);
    console.log('SendGrid sent to', to);
  } catch (e) {
    console.error('SendGrid error to', to, e && e.message);
  }
}

function buildEmail(heading, bodyContent) {
  return (
    '<div style="font-family:Arial,sans-serif;max-width:600px">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center">' +
    '<h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px">' +
    '<h2 style="color:#2C1A0E">' + heading + '</h2>' +
    bodyContent +
    '</div>' +
    '<div style="background:#1A0E08;padding:16px;text-align:center">' +
    '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>'
  );
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

exports.handler = async (event) => {
  let payload;
  try {
    payload = JSON.parse(event.body).payload;
  } catch (e) {
    console.log('submission-created: could not parse payload');
    return { statusCode: 200, body: 'OK' };
  }

  const formName = payload.form_name;
  const data = payload.data || {};
  console.log('submission-created fired for form:', formName);

  // ── Wine Club Registration ──
  if (formName === 'wine-club-registration') {
    const firstName = data.firstName || '';
    const lastName = data.lastName || '';
    const fullName = (firstName + ' ' + lastName).trim();
    const email = data.email || '';

    if (email) {
      await sendEmail({
        to: email,
        subject: 'Registration Confirmed — Rock & Vine Wine Club',
        html: buildEmail(
          'Welcome to the Club!',
          '<p>Hi ' + (firstName || 'there') + ', your Wine Club registration has been received!</p>' +
          '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
          '<p style="margin:4px 0"><b>Name:</b> ' + fullName + '</p>' +
          '<p style="margin:4px 0"><b>Email:</b> ' + email + '</p>' +
          '<p style="margin:4px 0"><b>Phone:</b> ' + (data.phone || 'N/A') + '</p></div>' +
          '<p>We\'ll be in touch with details about your membership. Questions? Call ' +
          '<a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email ' +
          '<a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p>'
        )
      });
    }

    await sendEmail({
      to: 'management@thequarrystl.com',
      subject: 'New Wine Club Registration — ' + fullName,
      html: buildEmail(
        'New Wine Club Registration',
        '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
        '<p style="margin:4px 0"><b>Name:</b> ' + fullName + '</p>' +
        '<p style="margin:4px 0"><b>Email:</b> ' + email + '</p>' +
        '<p style="margin:4px 0"><b>Phone:</b> ' + (data.phone || 'N/A') + '</p>' +
        '<p style="margin:4px 0"><b>Address:</b> ' + [data.street, data.city, data.state, data.zip].filter(Boolean).join(', ') + '</p>' +
        '<p style="margin:4px 0"><b>Birthdate:</b> ' + (data.birthdate || 'N/A') + '</p></div>'
      )
    });
  }

  // ── Wedding Tour Request ──
  if (formName === 'wedding-tour') {
    const firstName = data.first_name || '';
    const lastName = data.last_name || '';
    const fullName = (firstName + ' ' + lastName).trim() || 'New Inquiry';
    const email = data.email || '';
    const phone = data.phone || 'N/A';
    const weddingDate = data.wedding_date || 'Not specified';
    const packageInterest = data.package_interest || 'Not specified';
    const message = data.message || '';

    const detailBlock =
      '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
      '<p style="margin:4px 0"><b>Name:</b> ' + escapeHtml(fullName) + '</p>' +
      '<p style="margin:4px 0"><b>Email:</b> ' + escapeHtml(email) + '</p>' +
      '<p style="margin:4px 0"><b>Phone:</b> ' + escapeHtml(phone) + '</p>' +
      '<p style="margin:4px 0"><b>Wedding Date:</b> ' + escapeHtml(weddingDate) + '</p>' +
      '<p style="margin:4px 0"><b>Package Interest:</b> ' + escapeHtml(packageInterest) + '</p>' +
      (message ? '<p style="margin:12px 0 4px 0"><b>Vision / Notes:</b></p><p style="margin:0;white-space:pre-wrap">' + escapeHtml(message) + '</p>' : '') +
      '</div>';

    // 1. Primary notification → Jacqueline
    await sendEmail({
      to: 'jacqueline@thequarrystl.com',
      subject: 'New Wedding Tour Request — ' + fullName,
      html: buildEmail('New Wedding Tour Request', detailBlock +
        '<p>Reply directly to ' + (email ? '<a href="mailto:' + escapeHtml(email) + '" style="color:#B8933A">' + escapeHtml(email) + '</a>' : 'this couple') + ' to schedule their walkthrough.</p>')
    });

    // 2. CC → Management for visibility
    await sendEmail({
      to: 'management@thequarrystl.com',
      subject: 'New Wedding Tour Request — ' + fullName,
      html: buildEmail('New Wedding Tour Request', detailBlock +
        '<p style="font-size:0.85rem;color:#666">Jacqueline has been notified separately and will follow up directly.</p>')
    });

    // 3. Confirmation back to the couple
    if (email) {
      await sendEmail({
        to: email,
        subject: 'Your Tour Request Received — The Quarry Weddings',
        html: buildEmail(
          'Thank You for Reaching Out',
          '<p>Hi ' + (escapeHtml(firstName) || 'there') + ',</p>' +
          '<p>Thank you for requesting a tour of The Quarry. We have received your inquiry and Jacqueline Hirschbeck, our wedding coordinator, will personally reach out within one business day to schedule your private walkthrough.</p>' +
          '<p>Here is a summary of what you sent us:</p>' +
          detailBlock +
          '<p>In the meantime, feel free to explore our <a href="https://thequarrystl.com/weddings/gallery.html" style="color:#B8933A">gallery</a> or read more <a href="https://thequarrystl.com/weddings/planning.html" style="color:#B8933A">about our planning services</a>.</p>' +
          '<p>If you need to reach us sooner, call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email <a href="mailto:jacqueline@thequarrystl.com" style="color:#B8933A">jacqueline@thequarrystl.com</a>.</p>' +
          '<p>We look forward to meeting you.</p>' +
          '<p style="color:#666;font-size:0.9rem">— The Quarry Wedding Team</p>'
        )
      });
    }
  }

  return { statusCode: 200, body: 'OK' };
};
