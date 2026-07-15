const cron = require('node-cron');
const prisma = require('../db/client');
const shiprocketService = require('../services/shiprocketService');
const { enqueueEmail } = require('../queues/emailQueue');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Polls Shiprocket for shipment status updates on all in-flight orders.
 *
 * This is a FALLBACK for when Shiprocket webhooks are unreliable or not configured.
 * The cron job runs every N minutes (configurable via SHIPROCKET_POLL_INTERVAL_MINUTES).
 *
 * For each order with shippingStatus != delivered/returned:
 *   1. Fetch latest status from Shiprocket
 *   2. Compare with stored status
 *   3. If changed: update DB + trigger the correct email
 */

// Map from ShippingStatus enum → email type to send when entering that state
const STATUS_EMAIL_MAP = {
  shipped: 'order_shipped',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  returned: null, // Return emails are triggered separately via refund webhook
};

// Priority order for status transitions (can only go forward)
const STATUS_ORDER = ['none', 'shipped', 'out_for_delivery', 'delivered', 'returned'];

function isStatusProgression(currentStatus, newStatus) {
  const currentIdx = STATUS_ORDER.indexOf(currentStatus);
  const newIdx = STATUS_ORDER.indexOf(newStatus);
  return newIdx > currentIdx;
}

async function pollShiprocketStatuses() {
  logger.info('Shiprocket poll: starting status reconciliation...');

  // Find all orders that aren't in a terminal state
  const orders = await prisma.order.findMany({
    where: {
      shippingStatus: {
        notIn: ['delivered', 'returned'],
      },
      // Only poll orders that have an AWB code or shipment ID
      OR: [
        { awbCode: { not: null } },
        { shiprocketShipmentId: { not: null } },
      ],
    },
    take: 100,
  });

  if (orders.length === 0) {
    logger.info('Shiprocket poll: no in-flight orders to check');
    return;
  }

  logger.info(`Shiprocket poll: checking ${orders.length} order(s)`);

  for (const order of orders) {
    try {
      let trackingData;

      if (order.awbCode) {
        trackingData = await shiprocketService.trackShipment(order.awbCode);
      } else if (order.shiprocketShipmentId) {
        trackingData = await shiprocketService.trackShipmentById(order.shiprocketShipmentId);
      } else {
        continue;
      }

      // Extract the current status from tracking response
      // Shiprocket's tracking response structure:
      // trackingData.tracking_data.track_status or similar
     const rawStatus =
        trackingData?.tracking_data?.current_status ||
        trackingData?.current_status ||
        trackingData?.tracking_data?.shipment_status ||
        null;

      if (!rawStatus) {
        logger.debug('No status in Shiprocket tracking response', {
          orderId: order.id,
          awbCode: order.awbCode,
        });
        continue;
      }

      logger.info('Shiprocket raw tracking response', { orderId: order.id, rawStatus, trackingData });

      const mappedStatus = shiprocketService.mapShiprocketStatus(rawStatus);

      if (!mappedStatus) {
        logger.debug('Shiprocket status not mappable', { rawStatus, orderId: order.id });
        continue;
      }

      // Only process forward progressions (don't go backwards)
      if (!isStatusProgression(order.shippingStatus, mappedStatus)) {
        logger.debug('Shiprocket status not a progression, skipping', {
          orderId: order.id,
          currentStatus: order.shippingStatus,
          newStatus: mappedStatus,
        });
        continue;
      }

      // Update order in DB
      const trackingUrl =
        trackingData?.tracking_data?.track_url ||
        order.trackingUrl ||
        `https://shiprocket.co/tracking/${order.awbCode}`;

      await prisma.order.update({
        where: { id: order.id },
        data: {
          shippingStatus: mappedStatus,
          trackingUrl,
        },
      });

      logger.info('Shiprocket poll: order status updated', {
        orderId: order.id,
        from: order.shippingStatus,
        to: mappedStatus,
        rawStatus,
      });

      // Send the corresponding email
      const emailType = STATUS_EMAIL_MAP[mappedStatus];
      if (emailType) {
        await enqueueEmail({
          emailType,
          to: order.customerEmail,
          data: {
            customerName: order.customerName || '',
            orderNumber: order.orderNumber || `#${order.id}`,
            orderId: order.id,
            awbCode: order.awbCode || '',
            trackingUrl,
            courierName: order.courierName || 'Shiprocket',
            estimatedDelivery: order.estimatedDelivery || '',
            lineItems: Array.isArray(order.lineItems) ? order.lineItems : [],
          },
          orderId: order.id,
        });
      }
    } catch (err) {
      logger.error('Shiprocket poll: error processing order', {
        orderId: order.id,
        error: err.message,
      });
      // Continue with next order even if one fails
    }
  }

  logger.info('Shiprocket poll: reconciliation complete');
}

/**
 * Starts the Shiprocket polling cron job.
 * Interval is controlled by SHIPROCKET_POLL_INTERVAL_MINUTES env var.
 */
function startShiprocketPoller() {
  const intervalMinutes = config.shiprocket.pollIntervalMinutes;

  // Validate cron-compatible interval (1-59 minutes)
  if (intervalMinutes < 1 || intervalMinutes > 60) {
    logger.warn('Invalid SHIPROCKET_POLL_INTERVAL_MINUTES, defaulting to 30', { intervalMinutes });
  }

  const cronExpression = `*/${Math.max(1, Math.min(59, intervalMinutes))} * * * *`;

  logger.info(`Starting Shiprocket status poller`, {
    cronExpression,
    intervalMinutes,
  });

  const task = cron.schedule(cronExpression, async () => {
    try {
      await pollShiprocketStatuses();
    } catch (err) {
      logger.error('Shiprocket poller cron error', { error: err.message, stack: err.stack });
    }
  });

  // Run once immediately on startup (with a 10s delay to let DB connect)
  setTimeout(async () => {
    try {
      await pollShiprocketStatuses();
    } catch (err) {
      logger.error('Shiprocket poller initial run error', { error: err.message });
    }
  }, 10000);

  return task;
}

module.exports = { startShiprocketPoller, pollShiprocketStatuses };
