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
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Stripe secret key not configured' }) };
    }

    const stripe = Stripe(STRIPE_SECRET_KEY);

    try {
        // Fetch all subscriptions with customer expanded (keep expand shallow)
        const subscriptions = await stripe.subscriptions.list({
            limit: 100,
            expand: ['data.customer']
        });

        // Collect all unique product IDs from prices, then fetch product names
        const productIds = new Set();
        subscriptions.data.forEach(sub => {
            const item = sub.items.data[0];
            if (item && item.price && item.price.product) {
                productIds.add(item.price.product);
            }
        });

        // Fetch product details
        const productMap = {};
        for (const pid of productIds) {
            try {
                const product = await stripe.products.retrieve(pid);
                productMap[pid] = product.name;
            } catch (e) {
                productMap[pid] = 'Unknown Product';
            }
        }

        const subList = subscriptions.data.map(sub => {
            const item = sub.items.data[0];
            const price = item && item.price;
            const productId = price ? price.product : '';

            return {
                id: sub.id,
                customerId: sub.customer && typeof sub.customer === 'object' ? sub.customer.id : sub.customer,
                customerName: sub.customer && typeof sub.customer === 'object' ? sub.customer.name : '',
                customerEmail: sub.customer && typeof sub.customer === 'object' ? sub.customer.email : '',
                status: sub.status,
                productId: productId,
                productName: productMap[productId] || 'Unknown Product',
                amount: price ? price.unit_amount : 0,
                currency: price ? price.currency : 'usd',
                interval: price && price.recurring ? price.recurring.interval : '',
                intervalCount: price && price.recurring ? price.recurring.interval_count : 1,
                currentPeriodStart: sub.current_period_start,
                currentPeriodEnd: sub.current_period_end,
                created: sub.created,
                cancelAt: sub.cancel_at,
                canceledAt: sub.canceled_at,
                cancelAtPeriodEnd: sub.cancel_at_period_end
            };
        });

        // Get unique product names for filter dropdown
        const products = [...new Set(subList.map(s => s.productName))].sort();

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ subscriptions: subList, products: products })
        };

    } catch (err) {
        console.error('Stripe list subscriptions error:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
};
