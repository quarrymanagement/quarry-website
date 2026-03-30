const Stripe = require('stripe');

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_SECRET_KEY) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Stripe secret key not configured' })
        };
    }

    const stripe = Stripe(STRIPE_SECRET_KEY);

    try {
        // Fetch up to 100 most recent invoices
        const invoices = await stripe.invoices.list({
            limit: 100,
            expand: ['data.customer']
        });

        const invoiceList = invoices.data.map(inv => ({
            id: inv.id,
            number: inv.number,
            customerName: inv.customer_name || (inv.customer && inv.customer.name) || 'Unknown',
            customerEmail: inv.customer_email || (inv.customer && inv.customer.email) || '',
            amount: inv.amount_due,
            amountPaid: inv.amount_paid,
            currency: inv.currency,
            status: inv.status,
            created: inv.created,
            dueDate: inv.due_date,
            paid: inv.paid,
            description: inv.lines && inv.lines.data && inv.lines.data.length > 0
                ? inv.lines.data[0].description || ''
                : '',
            hostedUrl: inv.hosted_invoice_url,
            pdfUrl: inv.invoice_pdf
        }));

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ invoices: invoiceList })
        };

    } catch (err) {
        console.error('Stripe list invoices error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: err.message })
        };
    }
};
