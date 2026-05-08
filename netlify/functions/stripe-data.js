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
      expand: ['data.customer'], // so admin sees the live customer.email after edits
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
    const {
      customer_email,
      customer_name,
      description,
      amount,
      service_charge_enabled,
      service_charge_percent,
      cc_fee_enabled,
      cc_fee_percent,
      sales_tax_enabled,
      sales_tax_percent,
    } = body;

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

    // Create invoice with send_invoice collection method
    // FIX: Added auto_advance: true so Stripe automatically emails the invoice
    const invoice = await stripe.invoices.create({
      customer: customer.id,
      description,
      collection_method: 'send_invoice',
      days_until_due: 30,
      auto_advance: true,
    });

    // Add the base line item
    const baseAmount = parseInt(amount);
    await stripe.invoiceItems.create({
      customer: customer.id,
      invoice: invoice.id,
      amount: baseAmount,
      description,
      currency: 'usd',
    });

    // Add service charge as a separate line item
    let serviceChargeAmount = 0;
    if (service_charge_enabled && service_charge_percent > 0) {
      const svcPct = parseFloat(service_charge_percent);
      serviceChargeAmount = Math.round(baseAmount * (svcPct / 100));
      if (serviceChargeAmount > 0) {
        await stripe.invoiceItems.create({
          customer: customer.id,
          invoice: invoice.id,
          amount: serviceChargeAmount,
          currency: 'usd',
          description: `Service Charge (${svcPct}%)`,
        });
      }
    }

    // Add credit card processing fee, computed on subtotal + service charge
    let ccFeeAmount = 0;
    if (cc_fee_enabled && cc_fee_percent > 0) {
      const ccPct = parseFloat(cc_fee_percent);
      const base = baseAmount + serviceChargeAmount;
      ccFeeAmount = Math.round(base * (ccPct / 100));
      if (ccFeeAmount > 0) {
        await stripe.invoiceItems.create({
          customer: customer.id,
          invoice: invoice.id,
          amount: ccFeeAmount,
          currency: 'usd',
          description: `Credit Card Processing Fee (${ccPct}%)`,
        });
      }
    }

    // Add sales tax, computed on subtotal + service charge + cc fee
    if (sales_tax_enabled && sales_tax_percent > 0) {
      const taxPct = parseFloat(sales_tax_percent);
      const taxableAmount = baseAmount + serviceChargeAmount + ccFeeAmount;
      const taxAmount = Math.round(taxableAmount * (taxPct / 100));
      if (taxAmount > 0) {
        await stripe.invoiceItems.create({
          customer: customer.id,
          invoice: invoice.id,
          amount: taxAmount,
          currency: 'usd',
          description: `Sales Tax (${taxPct}%)`,
        });
      }
    }

    // Finalize the invoice
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

    // Send the invoice email to the customer
    // auto_advance: true above ensures delivery even if this call has issues
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

// Update an invoice's customer email.
// Stripe doesn't allow customer_email on invoices.update for finalized invoices,
// so we update the underlying customer record (which is what Stripe uses to send
// the invoice email). For draft invoices we also try to update customer_email
// directly. Optionally re-sends so the new address gets a payment notification.
const updateInvoiceEmail = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { invoice_id, email, resend } = body;

    if (!invoice_id) {
      return response(400, { success: false, error: 'Missing required field: invoice_id' });
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return response(400, { success: false, error: 'Provide a valid email address' });
    }

    // Pull the current invoice to find the customer + check status
    const inv = await stripe.invoices.retrieve(invoice_id);
    if (inv.status === 'void' || inv.status === 'paid' || inv.status === 'uncollectible') {
      return response(400, {
        success: false,
        error: 'Cannot edit ' + inv.status + ' invoice. Email changes only apply to draft/open invoices.',
      });
    }

    // 1) Update the underlying customer's email — this is the field Stripe uses
    //    when sending the hosted invoice email. Works for any non-terminal status.
    let customerUpdated = false;
    if (inv.customer) {
      try {
        await stripe.customers.update(inv.customer, { email: email });
        customerUpdated = true;
      } catch (custErr) {
        console.warn('Customer email update warning:', custErr.message);
      }
    }

    // 2) For DRAFT invoices, we can also override customer_email on the invoice itself.
    //    Open/finalized invoices reject this update — skip silently in that case.
    if (inv.status === 'draft') {
      try {
        await stripe.invoices.update(invoice_id, { customer_email: email });
      } catch (invErr) {
        console.warn('Invoice customer_email override warning:', invErr.message);
      }
    }

    // 3) Optionally re-send the invoice email to the new address
    let resent = false;
    if (resend && (inv.status === 'open' || inv.status === 'draft')) {
      try {
        if (inv.status === 'draft') {
          await stripe.invoices.finalizeInvoice(invoice_id);
        }
        await stripe.invoices.sendInvoice(invoice_id);
        resent = true;
      } catch (sendErr) {
        console.warn('Resend warning:', sendErr.message);
      }
    }

    // 4) Pull the latest invoice state to return
    const refreshed = await stripe.invoices.retrieve(invoice_id, { expand: ['customer'] });

    return response(200, {
      success: true,
      invoice: refreshed,
      customerUpdated,
      resent,
      message: 'Email updated to ' + email + (resent ? ' and invoice re-sent' : '') + (!customerUpdated ? ' (warning: customer record could not be updated)' : ''),
    });
  } catch (error) {
    console.error('Error updating invoice email:', error);
    return response(500, { success: false, error: error.message });
  }
};

// Void an invoice
const voidInvoice = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { invoice_id } = body;

    if (!invoice_id) {
      return response(400, { success: false, error: 'Missing required field: invoice_id' });
    }

    const invoice = await stripe.invoices.voidInvoice(invoice_id);
    return response(200, {
      success: true,
      invoice,
      message: 'Invoice voided successfully',
    });
  } catch (error) {
    console.error('Error voiding invoice:', error);
    return response(500, { success: false, error: error.message });
  }
};

// Send invoice reminder
const sendReminder = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { invoice_id } = body;

    if (!invoice_id) {
      return response(400, { success: false, error: 'Missing required field: invoice_id' });
    }

    // First, retrieve the invoice to check its status
    const invoice = await stripe.invoices.retrieve(invoice_id);

    if (invoice.status === 'void' || invoice.status === 'paid') {
      return response(400, {
        success: false,
        error: `Cannot send reminder for ${invoice.status} invoice`,
      });
    }

    if (invoice.status === 'draft') {
      // Finalize first, then send
      await stripe.invoices.finalizeInvoice(invoice_id);
    }

    // Send the invoice email to the customer
    await stripe.invoices.sendInvoice(invoice_id);

    return response(200, {
      success: true,
      message: 'Reminder sent successfully',
    });
  } catch (error) {
    console.error('Error sending reminder:', error);
    return response(500, { success: false, error: error.message });
  }
};

// Search customers across the full Stripe history (not limited to recent like list).
// Uses Stripe's Search API which supports email/name fuzzy matches.
const searchCustomers = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const email = (q.email || '').trim();
    const name  = (q.name  || '').trim();
    if (!email && !name) return response(400, { success: false, error: 'Provide ?email= or ?name=' });

    const parts = [];
    if (email) parts.push(`email~"${email.replace(/"/g, '')}"`);
    if (name)  parts.push(`name~"${name.replace(/"/g, '')}"`);
    const query = parts.join(' OR ');

    const result = await stripe.customers.search({ query, limit: 100 });
    return response(200, {
      success: true,
      query,
      data: result.data,
      has_more: result.has_more,
    });
  } catch (error) {
    console.error('Error searching customers:', error);
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
      case 'search-customers':
        return await searchCustomers(event);
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
      case 'void-invoice':
        if (event.httpMethod !== 'POST') {
          return response(405, { success: false, error: 'Method not allowed' });
        }
        return await voidInvoice(event);
      case 'send-reminder':
        if (event.httpMethod !== 'POST') {
          return response(405, { success: false, error: 'Method not allowed' });
        }
        return await sendReminder(event);
      case 'update-invoice-email':
        if (event.httpMethod !== 'POST') {
          return response(405, { success: false, error: 'Method not allowed' });
        }
        return await updateInvoiceEmail(event);
      default:
        return response(400, {
          success: false,
          error: 'Invalid action. Valid actions: customers, invoices, subscriptions, create-invoice, create-customer, create-payment-link, balance, void-invoice, send-reminder, update-invoice-email',
        });
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    return response(500, { success: false, error: 'Internal server error' });
  }
};

