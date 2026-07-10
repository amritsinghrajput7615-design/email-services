const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

// ─── Redis Connection ─────────────────────────────────────────

const connection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
});

connection.on('connect', () => logger.info('Redis connected'));
connection.on('error', (err) => logger.error('Redis connection error', { error: err.message }));

// ─── Queues ───────────────────────────────────────────────────

/**
 * Queue for sending individual emails.
 * Jobs: { emailType, to, data, orderId, checkoutId }
 */
const emailQueue = new Queue('emails', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s, 25s, 125s
    },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  },
});

/**
 * Queue for abandoned cart reminders.
 * Jobs: { checkoutId, reminderNumber }
 * Uses delayed jobs to fire after 1h and 24h.
 */
const abandonedCartQueue = new Queue('abandoned-cart', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 10000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

// ─── Convenience Helpers ──────────────────────────────────────

/**
 * Enqueues an email for immediate sending.
 */
async function enqueueEmail({ emailType, to, data, orderId, checkoutId }) {
  const job = await emailQueue.add(
    `send-${emailType}`,
    { emailType, to, data, orderId, checkoutId },
    { jobId: `${emailType}-${orderId || checkoutId || Date.now()}` }
  );
  logger.debug('Email enqueued', { jobId: job.id, emailType, to });
  return job;
}

/**
 * Schedules an abandoned-cart reminder job with a delay.
 *
 * @param {string} checkoutId
 * @param {1|2} reminderNumber
 * @param {number} delayMs
 * @returns {Promise<Job>}
 */
async function scheduleAbandonedCartReminder(checkoutId, reminderNumber, delayMs) {
  const jobId = `abandoned-cart-${checkoutId}-reminder${reminderNumber}`;

  // Remove existing job if re-scheduling
  const existing = await abandonedCartQueue.getJob(jobId);
  if (existing) {
    await existing.remove();
    logger.debug('Removed existing abandoned cart job', { jobId });
  }

  const job = await abandonedCartQueue.add(
    `reminder-${reminderNumber}`,
    { checkoutId, reminderNumber },
    { jobId, delay: delayMs }
  );

  logger.info('Scheduled abandoned cart reminder', {
    checkoutId,
    reminderNumber,
    delayMs,
    jobId: job.id,
    firesAt: new Date(Date.now() + delayMs).toISOString(),
  });

  return job;
}

/**
 * Cancels all pending abandoned-cart reminder jobs for a checkout.
 */
async function cancelAbandonedCartReminders(checkoutId) {
  const jobIds = [
    `abandoned-cart-${checkoutId}-reminder1`,
    `abandoned-cart-${checkoutId}-reminder2`,
  ];

  for (const jobId of jobIds) {
    const job = await abandonedCartQueue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === 'delayed' || state === 'waiting') {
        await job.remove();
        logger.info('Cancelled abandoned cart reminder job', { jobId });
      }
    }
  }
}

module.exports = {
  emailQueue,
  abandonedCartQueue,
  connection,
  enqueueEmail,
  scheduleAbandonedCartReminder,
  cancelAbandonedCartReminders,
};
