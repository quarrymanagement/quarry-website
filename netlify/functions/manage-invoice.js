const Stripe = require('stripe');

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_SECRET_KEY) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Stripe secret key not configured' }) };
    }

    const stripe = Stripe(STRIPE_SECRET_KEY);

    try {
        const { action, invoiceId } = JSON.parse(event.body);

        if (!invoiceId || !action) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing invoiceId or action' }) };
        }

        let result;

        switch (action) {
            case 'void':
                result = await stripe.invoices.voidInvoice(invoiceId);
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ success: true, status: result.status, message: 'Invoice voided' })
                };

            case 'send':
                result = await stripe.invoices.sendInvoice(invoiceId);
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ success: true, status: result.status, message: 'Invoice resent' })
                };

            case 'mark_uncollectible':
                result = await stripe.invoices.markUncollectible(invoiceId);
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ success: true, status: result.status, message: 'Invoice marked as uncollectible' })
                };

            default:
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action. Use: void, send, or mark_uncollectible' }) };
        }

    } catch (err) {
        console.error('Stripe manage invoice error:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
};
