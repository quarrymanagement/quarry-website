// Netlify event-triggered function: fires on every form submission
// Sends confirmation emails to both the registrant and the owner

exports.handler = async (event) => {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = 'roaring-pegasus-444826';

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
      // Confirmation to the new member
      await sendEmail(token, siteId, {
        from: 'wineclub@thequarrystl.com',
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

    // Notification to the owner
    await sendEmail(token, siteId, {
      from: 'wineclub@thequarrystl.com',
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

  return { statusCode: 200, body: 'OK' };
};

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

async function sendEmail(token, siteId, opts) {
  try {
    const res = await fetch('https://api.netlify.com/v1/sendEmail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        from: opts.from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        siteId
      })
    });
    console.log('Email sent to ' + opts.to + ', status:', res.status);
  } catch (e) {
    console.error('sendEmail error to ' + opts.to + ':', e.message);
  }
}
