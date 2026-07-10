const express = require('express');
const prisma = require('../db/client');
const { verifyShopifyHmac } = require('../middleware/shopifyHmac');
const { handleCheckoutEvent, markCheckoutConverted } = require('../services/abandonedCart');
const { enqueueEmail } = require('../queues/emailQueue');
const shiprocketService = require('../services/shiprocketService');
const logger = require('../utils/logger');

const router = express.Router();

// All Shopify webhook routes use express.raw() for HMAC verification
router.use(express.raw({ type: 'application/json' }));

// ─── Webhook Log Helper ────────────────────────────────────────

async function logWebhook(source, topic, payload, status = 'received', error = null) {
  try {
    await prisma.webhookLog.create({
      data: { source, topic, payload, status, error },
    });
  } catch (err) {
    logger.error('Failed to write webhook log', { error: err.message });
  }
}

// ─── Helper: Format shipping address ──────────────────────────

function formatShippingAddress(addr) {
  if (!addr) return '';
  const parts = [
    addr.name,
    addr.address1,
    addr.address2,
    addr.city,
    addr.province,
    addr.zip,
    addr.country,
  ].filter(Boolean);
  return parts.join(', ');
}

// ─── Helper: Normalize line items ─────────────────────────────

function normalizeLineItems(lineItems = []) {
  return lineItems.map((item) => ({
    name: item.title || item.name,
    variantTitle: item.variant_title,
    price: item.price,
    quantity: item.quantity,
    sku: item.sku,
    imageUrl: item.image?.src || item.image_url || '',
    productId: item.product_id,
  }));
}

// ─── POST /webhooks/shopify ────────────────────────────────────

router.post('/', verifyShopifyHmac, async (req, res) => {
  const topic = req.headers['x-shopify-topic'];
  const shopDomain = req.headers['x-shopify-shop-domain'];
  const payload = req.shopifyPayload; // Set by HMAC middleware after parsing

  logger.info('Shopify webhook received', { topic, shopDomain });

  // Acknowledge immediately — Shopify requires a 200 within 5 seconds
  res.status(200).json({ received: true });

  // Log raw webhook
  await logWebhook('shopify', topic, payload);

  // Process asynchronously (after responding)
  try {
    await handleShopifyEvent(topic, payload);
    // Update webhook log to processed
    const log = await prisma.webhookLog.findFirst({
      where: { source: 'shopify', topic },
      orderBy: { createdAt: 'desc' },
    });
    if (log) {
      await prisma.webhookLog.update({
        where: { id: log.id },
        data: { status: 'processed' },
      });
    }
  } catch (err) {
    logger.error('Error processing Shopify webhook', { topic, error: err.message, stack: err.stack });
    // Update webhook log to error
    const log = await prisma.webhookLog.findFirst({
      where: { source: 'shopify', topic },
      orderBy: { createdAt: 'desc' },
    });
    if (log) {
      await prisma.webhookLog.update({
        where: { id: log.id },
        data: { status: 'error', error: err.message },
      });
    }
  }
});

// ─── Event Handlers ────────────────────────────────────────────

async function handleShopifyEvent(topic, payload) {
  switch (topic) {
    case 'checkouts/create':
    case 'checkouts/update':
      await handleCheckout(payload);
      break;

    case 'orders/create':
      await handleOrderCreate(payload);
      break;

    case 'orders/paid':
      await handleOrderPaid(payload);
      break;

    case 'orders/fulfilled':
    case 'orders/updated':
      await handleOrderFulfillmentUpdate(payload);
      break;

    case 'refunds/create':
      await handleRefundCreate(payload);
      break;

    default:
      logger.debug('Unhandled Shopify topic', { topic });
  }
}

// ─── checkouts/create & checkouts/update ─────────────────────

async function handleCheckout(checkout) {
  await handleCheckoutEvent(checkout);
}

// ─── orders/create ────────────────────────────────────────────

async function handleOrderCreate(order) {
  const {
    id,
    checkout_id,
    email,
    customer,
    name: orderNumber,
    total_price,
    currency,
    line_items = [],
    shipping_address,
    financial_status,
  } = order;

  if (!email) {
    logger.warn('orders/create: no email on order', { orderId: id });
    return;
  }

  const customerName = customer
    ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim()
    : '';

  const lineItems = normalizeLineItems(line_items);

  // Upsert customer
  await prisma.customer.upsert({
    where: { email },
    create: { email, name: customerName || null },
    update: { name: customerName || undefined },
  });

  // Upsert order
  await prisma.order.upsert({
    where: { shopifyOrderId: String(id) },
    create: {
      id: String(id),
      shopifyOrderId: String(id),
      checkoutId: checkout_id ? String(checkout_id) : null,
      customerEmail: email,
      customerName: customerName || null,
      orderNumber: orderNumber || null,
      totalPrice: String(total_price || '0'),
      currency: currency || 'INR',
      lineItems,
      shippingAddress: formatShippingAddress(shipping_address),
      status: financial_status === 'paid' ? 'paid' : 'pending',
    },
    update: {
      customerName: customerName || undefined,
      lineItems,
      status: financial_status === 'paid' ? 'paid' : 'pending',
    },
  });

  // Mark checkout as converted (cancels reminder jobs)
  if (checkout_id) {
    await markCheckoutConverted(checkout_id);
  }

  logger.info('Order created/upserted', { orderId: id, checkoutId: checkout_id, email });
}

// ─── orders/paid ──────────────────────────────────────────────

async function handleOrderPaid(order) {
  const {
    id,
    checkout_id,
    email,
    customer,
    name: orderNumber,
    total_price,
    currency,
    line_items = [],
    shipping_address,
  } = order;

  if (!email) {
    logger.warn('orders/paid: no email on order', { orderId: id });
    return;
  }

  const customerName = customer
    ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim()
    : '';

  const lineItems = normalizeLineItems(line_items);

  // Upsert customer
  await prisma.customer.upsert({
    where: { email },
    create: { email, name: customerName || null },
    update: { name: customerName || undefined },
  });

  // Update order status
  await prisma.order.upsert({
    where: { shopifyOrderId: String(id) },
    create: {
      id: String(id),
      shopifyOrderId: String(id),
      checkoutId: checkout_id ? String(checkout_id) : null,
      customerEmail: email,
      customerName: customerName || null,
      orderNumber: orderNumber || null,
      totalPrice: String(total_price || '0'),
      currency: currency || 'INR',
      lineItems,
      shippingAddress: formatShippingAddress(shipping_address),
      status: 'paid',
    },
    update: { status: 'paid' },
  });

  // Mark checkout as converted (idempotent)
  if (checkout_id) {
    await markCheckoutConverted(checkout_id);
  }

  // Enqueue order confirmation email
  await enqueueEmail({
    emailType: 'order_confirmation',
    to: email,
    data: {
      customerName: customerName || 'Valued Customer',
      orderNumber: orderNumber || `#${id}`,
      orderId: String(id),
      orderTotal: String(total_price || '0'),
      currency: currency || 'INR',
      lineItems,
      shippingAddress: formatShippingAddress(shipping_address),
      estimatedDelivery: '5–7 business days',
      orderUrl: `${process.env.STORE_URL || ''}/orders/${id}`,
    },
    orderId: String(id),
  });

  logger.info('Order paid — confirmation email queued', { orderId: id, email });
}

// ─── orders/fulfilled & orders/updated ────────────────────────

async function handleOrderFulfillmentUpdate(order) {
  const { id, fulfillment_status, fulfillments = [] } = order;

  // Extract Shiprocket info from fulfillment tracking
  const fulfillment = fulfillments[0];
  if (!fulfillment) return;

  const trackingNumber = fulfillment.tracking_number;
  const trackingUrl = fulfillment.tracking_url;
  const trackingCompany = fulfillment.tracking_company;

  await prisma.order.updateMany({
    where: { shopifyOrderId: String(id) },
    data: {
      fulfillmentStatus: fulfillment_status || null,
      awbCode: trackingNumber || undefined,
      trackingUrl: trackingUrl || undefined,
      courierName: trackingCompany || undefined,
      ...(fulfillment_status === 'fulfilled' ? { status: 'fulfilled' } : {}),
    },
  });

  logger.info('Order fulfillment updated', { orderId: id, fulfillmentStatus: fulfillment_status });
}

// ─── refunds/create ───────────────────────────────────────────

async function handleRefundCreate(refund) {
  const { id: refundId, order_id, refund_line_items = [], transactions = [] } = refund;

  // Fetch order from DB
  const order = await prisma.order.findFirst({
    where: { shopifyOrderId: String(order_id) },
  });

  if (!order) {
    logger.warn('refunds/create: order not found in DB', { orderId: order_id });
    return;
  }

  // Calculate refund amount from transactions
  const refundAmount = transactions.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

  // Update order status to refunded
  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'refunded' },
  });

  // Enqueue refund email
  await enqueueEmail({
    emailType: 'refund_completed',
    to: order.customerEmail,
    data: {
      customerName: order.customerName || 'Valued Customer',
      orderNumber: order.orderNumber || `#${order_id}`,
      orderId: order.id,
      refundId: String(refundId),
      refundAmount: refundAmount.toFixed(2),
      currency: order.currency,
      refundMethod: 'Original payment method',
      processingDays: '5–7 business days',
    },
    orderId: order.id,
  });

  logger.info('Refund processed — email queued', { refundId, orderId: order_id });
}

module.exports = router;
