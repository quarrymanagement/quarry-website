// TEMPORARY diagnostic function — checks what OAuth scopes the existing
// GMAIL_REFRESH_TOKEN (management@thequarrystl.com) actually has, to see
// whether it can send mail (gmail.send / mail.google.com) in addition to
// the read-only search it's already used for (gmail-threads.js). Returns
// only the scope list, never the token itself. Delete after use.
const { google } = require('googleapis');

exports.handler = async () => {
    try {
        const oauth2Client = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID,
            process.env.GMAIL_CLIENT_SECRET,
            'https://developers.google.com/oauthplayground'
        );
        oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
        const { token } = await oauth2Client.getAccessToken();
        const info = await oauth2Client.getTokenInfo(token);
        return { statusCode: 200, body: JSON.stringify({ scopes: info.scopes, expiry_date: info.expiry_date }) };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};
