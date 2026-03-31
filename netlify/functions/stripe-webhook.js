const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Verify Stripe webhook signature
const verifyWebhookSignature = (event, signature) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.warn('STRIPE_WEBHOOK_SECRET not configured');
    return false;
  }

  try {
    const computedSignature = require('crypto')
      .createHmac('sha256', secret)
      .update(event)
      .digest('hex');

    return `t=${Math.floor(Date.now() / 1000)},v1=${computedSignature}` === signature;
  } catch (error) {
    console.error('Error verifying webhook signature:', error);
    return false;
  }
};

// Handle checkout.session.completed event
const handleCheckoutSessionCompleted = (data) => {
  console.log('Checkout session completed:', {
    sessionId: data.id,
    customerId: data.customer,
    paymentStatus: data.payment_status,
    amountTotal: data.amount_total,
    currency: data.currency,
    timestamp: new Date().toISOString(),
  });
  // TODO: Update order status, send confirmation email, etc.
};

// Handle invoice.paid event
const handleInvoicePaid = (data) => {
  console.log('Invoice paid:', {
    invoiceId: data.id,
    customerId: data.customer,
    amount: data.amount_paid,
    currency: data.currency,
    number: data.number,
    timestamp: new Date().toISOString(),
  });
  // TODO: Update customer status, process delivery, etc.
};

// Handle invoice.payment_failed event
const handleInvoicePaymentFailed = (data) => {
  console.log('Invoice payment failed:', {
    invoiceId: data.id,
    customerId: data.customer,
    amount: data.amount_due,
    currency: data.currency,
    number: data.number,
    timestamp: new Date().toISOString(),
  });
  // TODO: Send retry notification, update customer status, etc.
};

// Handle customer.subscription.created event
const handleSubscriptionCreated = (data) => {
  console.log('Subscription created:', {
    subscriptionId: data.id,
    customerId: data.customer,
    status: data.status,
    currentPeriodStart: data.current_period_start,
    currentPeriodEnd: data.current_period_end,
    timestamp: new Date().toISOString(),
  });
  // TODO: Activate subscription, send welcome email, etc.
};

// Handle customer.subscription.deleted event
const handleSubscriptionDeleted = (data) => {
  console.log('Subscription deleted:', {
    subscriptionId: data.id,
    customerId: data.customer,
    status: data.status,
    canceledAt: data.canceled_at,
    timestamp: new Date().toISOString(),
  });
  // TODO: Deactivate subscription, send cancellation email, etc.
};

// Main webhook handler
exports.handler = async (event) => {
  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const signature = event.headers['stripe-signature'];

    if (!signature) {
      console.error('Missing Stripe signature header');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing signature' }),
      };
    }

    // Verify signature - note: in Netlify, use raw body if available
    let webhookEvent;
    try {
      // Try to parse the event directly with stripe
      webhookEvent = stripe.webhooks.constructEvent(
        event.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error('Webhook signature verification failed:', error);
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Signature verification failed' }),
      };
    }

    // Log incoming webhook
    console.log('Received webhook event:', {
      type: webhookEvent.type,
      id: webhookEvent.id,
      timestamp: new Date().toISOString(),
    });

    // Handle specific event types
    switch (webhookEvent.type) {
      case 'checkout.session.completed':
        handleCheckoutSessionCompleted(webhookEvent.data.object);
        break;

      case 'invoice.paid':
        handleInvoicePaid(webhookEvent.data.object);
        break;

      case 'invoice.payment_failed':
        handleInvoicePaymentFailed(webhookEvent.data.object);
        break;

      case 'customer.subscription.created':
        handleSubscriptionCreated(webhookEvent.data.object);
        break;

      case 'customer.subscription.deleted':
        handleSubscriptionDeleted(webhookEvent.data.object);
        break;

      default:
        console.log(`Unhandled webhook event type: ${webhookEvent.type}`);
    }

    // Return success response
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true }),
    };
  } catch (error) {
    console.error('Webhook error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
