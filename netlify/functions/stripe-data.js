const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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

// List all customers with pagination
const listCustomers = async (event) => {
  try {
    const limit = event.queryStringParameters?.limit || 10;
    const starting_after = event.queryStringParameters?.starting_after || undefined;

    const customers = await stripe.customers.list({
      limit: Math.min(parseInt(limit), 100),
      starting_after,
    });

    return response(200, {
      success: true,
      data: customers.data,
      has_more: customers.has_more,
      next_cursor: customers.data.length > 0 ? customers.data[customers.data.length - 1].id : null,
    });
  } catch (error) {
    console.error('Error listing customers:', error);
    return response(500, { success: false, error: error.message });
  }
};

// List all invoices with pagination
const listInvoices = async (event) => {
  try {
    const limit = event.queryStringParameters?.limit || 10;
    const starting_after = event.queryStringParameters?.starting_after || undefined;

    const invoices = await stripe.invoices.list({
      limit: Math.min(parseInt(limit), 100),
      starting_after,
    });

    return response(200, {
      success: true,
      data: invoices.data,
      has_more: invoices.has_more,
      next_cursor: invoices.data.length > 0 ? invoices.data[invoices.data.length - 1].id : null,
    });
  } catch (error) {
    console.error('Error listing invoices:', error);
    return response(500, { success: false, error: error.message });
  }
};

// List all subscriptions
const listSubscriptions = async (event) => {
  try {
    const limit = event.queryStringParameters?.limit || 10;
    const starting_after = event.queryStringParameters?.starting_after || undefined;

    const subscriptions = await stripe.subscriptions.list({
      limit: Math.min(parseInt(limit), 100),
      starting_after,
    });

    return response(200, {
      success: true,
      data: subscriptions.data,
      has_more: subscriptions.has_more,
      next_cursor: subscriptions.data.length > 0 ? subscriptions.data[subscriptions.data.length - 1].id : null,
    });
  } catch (error) {
    console.error('Error listing subscriptions:', error);
    return response(500, { success: false, error: error.message });
  }
};

// Create and send an invoice
const createInvoice = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { customer_email, customer_name, description, amount } = body;

    if (!customer_email || !customer_name || !description || amount === undefined) {
      return response(400, {
        success: false,
        error: 'Missing required fields: customer_email, customer_name, description, amount',
      });
    }

    // Find or create customer
    let customer;
    const existingCustomers = await stripe.customers.list({ email: customer_email, limit: 1 });

    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({
        email: customer_email,
        name: customer_name,
      });
    }

    // Create invoice
    const invoice = await stripe.invoices.create({
      customer: customer.id,
      description,
    });

    // Add line item
    await stripe.invoiceItems.create({
      customer: customer.id,
      invoice: invoice.id,
      amount: parseInt(amount),
      description,
      currency: 'usd',
    });

    // Finalize and send
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(invoice.id);

    return response(200, {
      success: true,
      invoice: finalizedInvoice,
      message: 'Invoice created and sent successfully',
    });
  } catch (error) {
    console.error('Error creating invoice:', error);
    return response(500, { success: false, error: error.message });
  }
};

// Create a new Stripe customer
const createCustomer = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { email, name, phone } = body;

    if (!email || !name) {
      return response(400, {
        success: false,
        error: 'Missing required fields: email, name',
      });
    }

    const customer = await stripe.customers.create({
      email,
      name,
      phone: phone || undefined,
    });

    return response(200, {
      success: true,
      customer,
    });
  } catch (error) {
    console.error('Error creating customer:', error);
    return response(500, { success: false, error: error.message });
  }
};

// Create a payment link for an event
const createPaymentLink = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { event_name, amount, description } = body;

    if (!event_name || amount === undefined) {
      return response(400, {
        success: false,
        error: 'Missing required fields: event_name, amount',
      });
    }

    // Create a product for this event
    const product = await stripe.products.create({
      name: event_name,
      description: description || `Event: ${event_name}`,
      type: 'service',
    });

    // Create a price for the product
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: parseInt(amount),
      currency: 'usd',
      type: 'one_time',
    });

    // Create payment link
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [
        {
          price: price.id,
          quantity: 1,
        },
      ],
    });

    return response(200, {
      success: true,
      paymentLink,
      url: paymentLink.url,
    });
  } catch (error) {
    console.error('Error creating payment link:', error);
    return response(500, { success: false, error: error.message });
  }
};

// Get account balance
const getBalance = async (event) => {
  try {
    const balance = await stripe.balance.retrieve();

    return response(200, {
      success: true,
      balance,
    });
  } catch (error) {
    console.error('Error retrieving balance:', error);
    return response(500, { success: false, error: error.message });
  }
};

// Main handler
exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return handleOptions();
  }

  const action = event.queryStringParameters?.action;

  try {
    switch (action) {
      case 'customers':
        return await listCustomers(event);
      case 'invoices':
        return await listInvoices(event);
      case 'subscriptions':
        return await listSubscriptions(event);
      case 'create-invoice':
        if (event.httpMethod !== 'POST') {
          return response(405, { success: false, error: 'Method not allowed' });
        }
        return await createInvoice(event);
      case 'create-customer':
        if (event.httpMethod !== 'POST') {
          return response(405, { success: false, error: 'Method not allowed' });
        }
        return await createCustomer(event);
      case 'create-payment-link':
        if (event.httpMethod !== 'POST') {
          return response(405, { success: false, error: 'Method not allowed' });
        }
        return await createPaymentLink(event);
      case 'balance':
        return await getBalance(event);
      default:
        return response(400, {
          success: false,
          error: 'Invalid action. Valid actions: customers, invoices, subscriptions, create-invoice, create-customer, create-payment-link, balance',
        });
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    return response(500, { success: false, error: 'Internal server error' });
  }
};
