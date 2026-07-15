require('dotenv').config();

const express = require('express');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

// ─── Import Workers (start processing on boot) ─────────────────
require('./queues/workers/emailWorker');

// ─── Import Shopify registrar (optional: auto-register webhooks) ─
// require('./utils/registerWebhooks'); // Uncomment after setup

// ─── Create App ────────────────────────────────────────────────
const app = express();

// ─── Webhooks (mounted BEFORE the global JSON parser) ──────────
// Each webhook router applies its own express.raw() internally. If the
// global express.json() below ran first, it would consume the request
// stream and there'd be nothing raw left for these routers to verify.
app.use('/webhooks/shopify', require('./webhooks/shopify'));
app.use('/webhooks/shiprocket', require('./webhooks/shiprocket'));
app.use('/webhooks/fastrr', require('./webhooks/fastrr'));

// ─── Body Parsing (global — applies to everything mounted after this) ──
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Static Dashboard ──────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, '../public/dashboard')));

// ─── Health Check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'shopify-email-automation',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});
// ─── Root route ────────────────────────────────────────────────
// Returns a JSON status payload instead of 404-ing — Shopify's embedded app
// iframe and health monitors hit GET / directly.
app.get('/', (req, res) => {
  res.json({
    service: 'shopify-email-automation',
    status: 'ok',
    dashboard: '/dashboard',
    health: '/health',
    webhooks: {
      shopify: '/webhooks/shopify',
      shiprocket: '/webhooks/shiprocket',
      fastrr: '/webhooks/fastrr',
    },
  });
});

// ─── Admin API ─────────────────────────────────────────────────
app.use('/api/admin', require('./routes/admin'));

// ─── Unsubscribe ───────────────────────────────────────────────
app.use('/unsubscribe', require('./routes/unsubscribe'));

// ─── 404 & Error Handlers ─────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Start Server ──────────────────────────────────────────────
async function start() {
  try {
    // Verify DB connection
    const prisma = require('./db/client');
    await prisma.$connect();
    logger.info('✅ Database connected');

    // Start Shiprocket poller
    if (config.shiprocket.email && config.shiprocket.password) {
      const { startShiprocketPoller } = require('./jobs/shiprocketPoller');
      startShiprocketPoller();
      logger.info('✅ Shiprocket poller started');
    } else {
      logger.warn('⚠️  Shiprocket credentials not set — polling disabled');
    }

    // Start HTTP server
    app.listen(config.port, () => {
      logger.info(`🚀 Server running on port ${config.port}`);
      logger.info(`📊 Dashboard: http://localhost:${config.port}/dashboard`);
      logger.info(`🔗 Shopify webhook URL:    ${config.appUrl}/webhooks/shopify`);
      logger.info(`🔗 Shiprocket webhook URL: ${config.appUrl}/webhooks/shiprocket`);
      logger.info(`🔗 Fastrr webhook URL:     ${config.appUrl}/webhooks/fastrr`);
      logger.info(`❤️  Health: http://localhost:${config.port}/health`);
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// ─── Graceful Shutdown ─────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  const prisma = require('./db/client');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

start();

module.exports = app;
