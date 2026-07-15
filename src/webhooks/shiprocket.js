const express = require('express');
const prisma = require('../db/client');
const { enqueueEmail } = require('../queues/emailQueue');
const shiprocketService = require('../services/shiprocketService');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Webhook Log Helper ───────────────────────────────────────

async function logWebhook(topic, payload, status = 'received', error = null) {
  try {
    const log = await prisma.webhookLog.create({
      data: { source: 'shiprocket', topic, payload, status, error },
    });
    return log; // Return the created row so callers can use log.id directly
  } catch (err) {
    logger.error('Failed to write Shiprocket webhook log', { error: err.message });
    return null;
  }
}

// Priority order for status transitions
const STATUS_ORDER = ['none', 'shipped', 'out_for_delivery', 'delivered', 'returned'];

function isStatusProgression(currentStatus, newStatus) {
  const currentIdx = STATUS_ORDER.indexOf(currentStatus);
  const newIdx = STATUS_ORDER.indexOf(newStatus);
  return newIdx > currentIdx;
}

// ─── POST /webhooks/shiprocket ────────────────────────────────
//
// Receives real-time shipment status updates from Shiprocket
// when webhooks are enabled on the Shiprocket account.
//
// Shiprocket webhook payload varies by account setup; we handle
// the most common format documented in their API docs.
//

router.post('/', express.json(), async (req, res) => {
  const payload = req.body;
  const topic = `shipment_${payload?.current_status || payload?.status || 'update'}`;

  logger.info('Shiprocket webhook received', { topic, awb: payload?.awb_code });

  // Acknowledge immediately
  res.status(200).json({ received: true });

  const log = await logWebhook(topic, payload);

  try {
    await handleShiprocketWebhook(payload);

    // Update log to processed using the ID returned from logWebhook (avoids race condition)
    if (log) {
      await prisma.webhookLog.update({
        where: { id: log.id },
        data: { status: 'processed' },
      });
    }
  } catch (err) {
    logger.error('Error processing Shiprocket webhook', { error: err.message, stack: err.stack });
    if (log) {
      await prisma.webhookLog.update({
        where: { id: log.id },
        data: { status: 'error', error: err.message },
      });
    }
  }
});

async function handleShiprocketWebhook(payload) {
  // Shiprocket webhook fields (varies; we handle multiple formats)
  const awbCode =
    payload?.awb_code ||
    payload?.awb ||
    payload?.tracking_id ||
    null;

  const rawStatus =
    payload?.current_status ||
    payload?.status ||
    payload?.shipment_status ||
    null;

  const shiprocketOrderId =
    payload?.order_id ||
    payload?.shipment_id ||
    null;

  if (!rawStatus) {
    logger.warn('Shiprocket webhook: no status in payload');
    return;
  }

  logger.info('Shiprocket raw tracking response', { orderId: order.id, rawStatus, trackingData });

  const mappedStatus = shiprocketService.mapShiprocketStatus(rawStatus);
  if (!mappedStatus) {
    logger.debug('Shiprocket webhook: unmappable status', { rawStatus });
    return;
  }

  // Find the order by AWB code or Shiprocket order ID
  let order = null;

  if (awbCode) {
    order = await prisma.order.findFirst({ where: { awbCode } });
  }

  if (!order && shiprocketOrderId) {
    order = await prisma.order.findFirst({
      where: { shiprocketShipmentId: String(shiprocketOrderId) },
    });
  }

  if (!order) {
    logger.warn('Shiprocket webhook: no matching order found', {
      awbCode,
      shiprocketOrderId,
      rawStatus,
    });
    return;
  }

  // Only process forward progressions
  if (!isStatusProgression(order.shippingStatus, mappedStatus)) {
    logger.debug('Shiprocket webhook: status not a progression, skipping', {
      orderId: order.id,
      currentStatus: order.shippingStatus,
      newStatus: mappedStatus,
    });
    return;
  }

  // Build tracking URL
  const trackingUrl =
    payload?.tracking_url ||
    order.trackingUrl ||
    (awbCode ? `https://shiprocket.co/tracking/${awbCode}` : '');

  // Extract courier info
  const courierName = payload?.courier_name || order.courierName || 'Shiprocket';

  // Update order in DB
  await prisma.order.update({
    where: { id: order.id },
    data: {
      shippingStatus: mappedStatus,
      trackingUrl,
      courierName,
      awbCode: awbCode || order.awbCode,
      shiprocketShipmentId: shiprocketOrderId
        ? String(shiprocketOrderId)
        : order.shiprocketShipmentId,
    },
  });

  logger.info('Order shipping status updated via webhook', {
    orderId: order.id,
    from: order.shippingStatus,
    to: mappedStatus,
  });

  // Trigger corresponding email
  const EMAIL_MAP = {
    shipped: 'order_shipped',
    out_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
    returned: null, // Handled by Shopify refunds/create
  };

  const emailType = EMAIL_MAP[mappedStatus];
  if (emailType) {
    await enqueueEmail({
      emailType,
      to: order.customerEmail,
      data: {
        customerName: order.customerName || 'Valued Customer',
        orderNumber: order.orderNumber || `#${order.id}`,
        orderId: order.id,
        awbCode: awbCode || order.awbCode || '',
        trackingUrl,
        courierName,
        estimatedDelivery: order.estimatedDelivery || '',
        lineItems: Array.isArray(order.lineItems) ? order.lineItems : [],
        deliveryDate: new Date().toLocaleDateString('en-IN', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }),
        reviewUrl: `${process.env.STORE_URL || ''}/pages/reviews`,
      },
      orderId: order.id,
    });

    logger.info(`${emailType} email queued via Shiprocket webhook`, { orderId: order.id });
  }
}

module.exports = router;
