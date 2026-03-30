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
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Stripe secret key not configured' })
        };
    }

    const stripe = Stripe(STRIPE_SECRET_KEY);

    try {
        const { customerName, customerEmail, description, amount, dueDate, eventDate } = JSON.parse(event.body);

        // Validate required fields
        if (!customerName || !customerEmail || !description || !amount) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Missing required fields: customerName, customerEmail, description, amount' })
            };
        }

        // 1. Search for existing customer by email, or create new one
        const existingCustomers = await stripe.customers.list({ email: customerEmail, limit: 1 });
        let customer;
        if (existingCustomers.data.length > 0) {
            customer = existingCustomers.data[0];
        } else {
            customer = await stripe.customers.create({
                name: customerName,
                email: customerEmail
            });
        }

        // 2. Create a product with event date in the description
        const productName = eventDate
            ? `${description} - Event Date: ${eventDate}`
            : description;

        const product = await stripe.products.create({
            name: productName,
            description: eventDate
                ? `${description} | Event Date: ${eventDate}`
                : description
        });

        // 3. Create a price (amount is in dollars, convert to cents)
        const amountInCents = Math.round(parseFloat(amount) * 100);
        const price = await stripe.prices.create({
            product: product.id,
            unit_amount: amountInCents,
            currency: 'usd'
        });

        // 4. Calculate days until due
        let daysUntilDue = 30; // default
        if (dueDate) {
            const due = new Date(dueDate + 'T00:00:00');
            const now = new Date();
            const diffMs = due.getTime() - now.getTime();
            daysUntilDue = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
        }

        // 5. Create the invoice
        const invoice = await stripe.invoices.create({
            customer: customer.id,
            collection_method: 'send_invoice',
            days_until_due: daysUntilDue
        });

        // 6. Add the line item
        await stripe.invoiceItems.create({
            customer: customer.id,
            invoice: invoice.id,
            price: price.id
        });

        // 7. Finalize and send the invoice
        const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

        // 8. Send the invoice email
        await stripe.invoices.sendInvoice(invoice.id);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                invoiceId: finalizedInvoice.id,
                invoiceUrl: finalizedInvoice.hosted_invoice_url,
                invoicePdf: finalizedInvoice.invoice_pdf,
                amountDue: finalizedInvoice.amount_due,
                customerName: customerName,
                customerEmail: customerEmail,
                status: finalizedInvoice.status
            })
        };

    } catch (err) {
        console.error('Stripe invoice error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: err.message })
        };
    }
};
