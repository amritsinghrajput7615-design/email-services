const express = require('express');
const prisma = require('../db/client');
const { sendEmail } = require('../services/emailService');
const { emailQueue, abandonedCartQueue } = require('../queues/emailQueue');
const config = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Dashboard Auth Middleware ─────────────────────────────────

function dashboardAuth(req, res, next) {
  if (!config.dashboard.token) {
    return next(); // Auth disabled
  }

  const authHeader = req.headers['authorization'];
  const queryToken = req.query.token;

  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : queryToken;

  if (!token || token !== config.dashboard.token) {
    return res.status(401).json({ error: 'Unauthorized. Provide a valid DASHBOARD_TOKEN.' });
  }

  next();
}

router.use(dashboardAuth);

// ─── GET /api/admin/stats ──────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const [totalSent, totalFailed, activeAbandoned, recovered] = await Promise.all([
      prisma.emailLog.count({ where: { status: 'sent' } }),
      prisma.emailLog.count({ where: { status: 'failed' } }),
      prisma.checkout.count({ where: { status: 'abandoned' } }),
      prisma.checkout.count({ where: { status: 'converted' } }),
    ]);

    // Also get queue sizes
    let queueStats = {};
    try {
      const [emailWaiting, emailActive, emailFailed] = await Promise.all([
        emailQueue.getWaitingCount(),
        emailQueue.getActiveCount(),
        emailQueue.getFailedCount(),
      ]);
      queueStats = { emailWaiting, emailActive, emailFailed };
    } catch (err) {
      // Redis might not be available
      logger.debug('Could not get queue stats', { error: err.message });
    }

    res.json({ totalSent, totalFailed, activeAbandoned, recovered, queueStats });
  } catch (err) {
    logger.error('Admin stats error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/email-logs ─────────────────────────────────

router.get('/email-logs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip = (page - 1) * limit;
    const type = req.query.type || '';
    const status = req.query.status || '';

    const where = {
      ...(type && type !== 'all' ? { emailType: type } : {}),
      ...(status && status !== 'all' ? { status } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.emailLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.emailLog.count({ where }),
    ]);

    res.json({
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    logger.error('Admin email-logs error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/abandoned-carts ───────────────────────────

router.get('/abandoned-carts', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip = (page - 1) * limit;

    const where = {
      status: { in: ['active', 'abandoned'] },
    };

    const [data, total] = await Promise.all([
      prisma.checkout.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.checkout.count({ where }),
    ]);

    res.json({
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    logger.error('Admin abandoned-carts error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/orders ─────────────────────────────────────

router.get('/orders', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.order.count(),
    ]);

    res.json({ data, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/webhook-logs ──────────────────────────────

router.get('/webhook-logs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip = (page - 1) * limit;
    const source = req.query.source || '';

    const where = {
      ...(source && source !== 'all' ? { source } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.webhookLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          source: true,
          topic: true,
          status: true,
          error: true,
          createdAt: true,
          // Exclude full payload for list view (can be huge)
        },
      }),
      prisma.webhookLog.count({ where }),
    ]);

    res.json({ data, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    logger.error('Admin webhook-logs error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/webhook-logs/:id ──────────────────────────
// Returns the full raw payload for a single webhook log

router.get('/webhook-logs/:id', async (req, res) => {
  try {
    const log = await prisma.webhookLog.findUnique({ where: { id: req.params.id } });
    if (!log) return res.status(404).json({ error: 'Not found' });
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/resend-email/:logId ──────────────────────
// Manually resend an email by its log ID

router.post('/resend-email/:logId', async (req, res) => {
  try {
    const log = await prisma.emailLog.findUnique({ where: { id: req.params.logId } });
    if (!log) return res.status(404).json({ error: 'Email log not found' });

    // Fetch context data to reconstruct the email
    let data = {};
    let to = log.recipientEmail;

    if (log.orderId) {
      const order = await prisma.order.findUnique({ where: { id: log.orderId } });
      if (order) {
        data = {
          customerName: order.customerName || 'Valued Customer',
          orderNumber: order.orderNumber || `#${order.id}`,
          orderId: order.id,
          orderTotal: order.totalPrice,
          currency: order.currency,
          lineItems: Array.isArray(order.lineItems) ? order.lineItems : [],
          shippingAddress: order.shippingAddress || '',
          awbCode: order.awbCode || '',
          trackingUrl: order.trackingUrl || '',
          courierName: order.courierName || '',
          refundAmount: order.totalPrice,
          refundMethod: 'Original payment method',
          processingDays: '5–7 business days',
          refundId: '',
        };
      }
    } else if (log.checkoutId) {
      const checkout = await prisma.checkout.findUnique({ where: { id: log.checkoutId } });
      if (checkout) {
        data = {
          customerName: '',
          cartItems: Array.isArray(checkout.cartItems) ? checkout.cartItems : [],
          cartTotal: checkout.totalPrice,
          currency: checkout.currency,
          checkoutUrl: checkout.checkoutUrl || config.store.url,
          discountCode: config.cart.discountCode,
          discountText: config.cart.discountText,
        };
      }
    }

    // Send directly (bypass idempotency for manual resend)
    const result = await sendEmail({ emailType: log.emailType, to, data });

    // Create a new log entry for the resend
    await prisma.emailLog.create({
      data: {
        emailType: log.emailType,
        recipientEmail: to,
        orderId: log.orderId || null,
        checkoutId: log.checkoutId || null,
        status: 'sent',
        attempts: 1,
        sentAt: new Date(),
        resendId: result.id || null,
        subject: `[Resent] via admin`,
      },
    });

    logger.info('Email manually resent via admin', { logId: log.id, emailType: log.emailType, to });
    res.json({ success: true, messageId: result.id });
  } catch (err) {
    logger.error('Admin resend-email error', { error: err.message, logId: req.params.logId });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/customers ─────────────────────────────────

router.get('/customers', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.customer.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.customer.count(),
    ]);

    res.json({ data, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
