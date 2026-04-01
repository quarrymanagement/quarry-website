// Fetches reservation data from the public Google Sheet "Events at The Quarry"
// Uses the public CSV export (no API key or OAuth needed since the sheet is shared via link)

const https = require('https');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const response = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

// Spreadsheet ID and sheet GID
const SPREADSHEET_ID = '1jeB3C1O3ToByrCdMjZrK_SkPEIGBDwCm791-Af4X1cM';
const SHEET_GID = '1519975875'; // "Mass Schedule Final" tab

// Fetch URL with redirect following
function fetchWithRedirects(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchWithRedirects(res.headers.location, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Simple CSV parser that handles quoted fields
function parseCSV(text) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  const lines = text.split('\n');

  for (const line of lines) {
    if (inQuotes) {
      current += '\n' + line;
    } else {
      current = line;
    }

    // Count unescaped quotes
    const quoteCount = (current.match(/"/g) || []).length;
    inQuotes = quoteCount % 2 !== 0;

    if (!inQuotes) {
      // Parse the complete line
      const fields = [];
      let field = '';
      let insideQuote = false;

      for (let i = 0; i < current.length; i++) {
        const ch = current[i];
        if (ch === '"') {
          if (insideQuote && current[i + 1] === '"') {
            field += '"';
            i++; // skip escaped quote
          } else {
            insideQuote = !insideQuote;
          }
        } else if (ch === ',' && !insideQuote) {
          fields.push(field.trim());
          field = '';
        } else {
          field += ch;
        }
      }
      fields.push(field.trim());
      rows.push(fields);
      current = '';
    }
  }

  return rows;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return response(200, { message: 'OK' });
  }

  if (event.httpMethod !== 'GET') {
    return response(405, { success: false, error: 'Method not allowed' });
  }

  try {
    // Fetch the public CSV export of the sheet
    const csvUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
    const csvText = await fetchWithRedirects(csvUrl);

    if (!csvText || csvText.length < 10) {
      return response(500, { success: false, error: 'Empty response from Google Sheets' });
    }

    // Parse CSV
    const rows = parseCSV(csvText);
    if (rows.length < 2) {
      return response(200, { success: true, reservations: [], total: 0 });
    }

    // First row is headers
    const headers = rows[0].map(h => (h || '').trim().toLowerCase());
    const dataRows = rows.slice(1);

    // Map column indices by matching header text
    const colIndex = {};
    const columnMap = {
      'event type': 'eventType',
      'status': 'status',
      'event details': 'eventDetails',
      'location': 'location',
      'date': 'date',
      'time': 'time',
      '# guests': 'guests',
      'catering': 'catering',
      'deposit': 'deposit',
      'remaining balance': 'remainingBalance',
      'payment complete': 'paymentComplete',
      'contact person': 'contactPerson',
      'phone number': 'phone',
      'email': 'email',
      'notes': 'notes',
      'sync status': 'syncStatus',
    };

    headers.forEach((h, i) => {
      for (const [key, field] of Object.entries(columnMap)) {
        if (h.includes(key) || key.includes(h)) {
          colIndex[field] = i;
        }
      }
    });

    // Parse rows into reservation objects
    const reservations = [];
    for (const row of dataRows) {
      const get = (field) => (colIndex[field] !== undefined && row[colIndex[field]]) ? row[colIndex[field]].trim() : '';

      const eventType = get('eventType');
      const eventDetails = get('eventDetails');
      const contactPerson = get('contactPerson');
      const dateStr = get('date');

      // Skip empty rows
      if (!eventType && !eventDetails && !contactPerson && !dateStr) continue;

      const reservation = {
        id: `sheet_${reservations.length}`,
        eventType: eventType,
        status: get('status'),
        eventDetails: eventDetails,
        location: get('location'),
        date: dateStr,
        time: get('time'),
        guests: get('guests'),
        catering: get('catering'),
        deposit: get('deposit'),
        remainingBalance: get('remainingBalance'),
        paymentComplete: get('paymentComplete'),
        contact: {
          name: contactPerson,
          phone: get('phone'),
          email: get('email'),
        },
        notes: get('notes'),
        syncStatus: get('syncStatus'),
      };

      // Parse date into ISO format for sorting
      if (dateStr) {
        try {
          const timeStr = get('time') || '12:00 PM';
          // Handle time ranges like "10:30 AM - 4:00 PM" by taking the start time
          const startTime = timeStr.split('-')[0].trim();
          const parsed = new Date(dateStr + ' ' + startTime);
          if (!isNaN(parsed.getTime())) {
            reservation.startISO = parsed.toISOString();
          }
        } catch (e) {
          // Leave startISO undefined
        }
      }

      reservations.push(reservation);
    }

    // Sort by date ascending
    reservations.sort((a, b) => {
      const da = a.startISO ? new Date(a.startISO) : new Date(0);
      const db = b.startISO ? new Date(b.startISO) : new Date(0);
      return da - db;
    });

    return response(200, {
      success: true,
      reservations,
      total: reservations.length,
      columns: headers,
    });
  } catch (error) {
    console.error('Google Sheets fetch error:', error.message);
    return response(500, { success: false, error: error.message });
  }
};
