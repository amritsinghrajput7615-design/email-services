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

// ─── Body Parsing (global — webhooks override with raw) ────────
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

// ─── Webhooks ──────────────────────────────────────────────────
// Note: Shopify webhook route uses express.raw() internally
app.use('/webhooks/shopify', require('./webhooks/shopify'));
app.use('/webhooks/shiprocket', require('./webhooks/shiprocket'));

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
      logger.info(`🔗 Shopify webhook URL: ${config.appUrl}/webhooks/shopify`);
      logger.info(`🔗 Shiprocket webhook URL: ${config.appUrl}/webhooks/shiprocket`);
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
