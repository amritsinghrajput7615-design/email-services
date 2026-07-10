const { Worker } = require('bullmq');
const prisma = require('../../db/client');
const { sendEmail } = require('../../services/emailService');
const { enqueueEmail, scheduleAbandonedCartReminder, connection } = require('../emailQueue');
const config = require('../../config');
const logger = require('../../utils/logger');

// ─── Email Worker ─────────────────────────────────────────────
//
// Processes jobs from the 'emails' queue.
// Implements idempotency: checks email_logs before sending.
//

const emailWorker = new Worker(
  'emails',
  async (job) => {
    const { emailType, to, data, orderId, checkoutId } = job.data;

    logger.info('Processing email job', {
      jobId: job.id,
      emailType,
      to,
      orderId,
      checkoutId,
      attempt: job.attemptsMade + 1,
    });

    // ── Idempotency check ─────────────────────────────────────
    const existing = await prisma.emailLog.findFirst({
      where: {
        emailType,
        ...(orderId ? { orderId } : {}),
        ...(checkoutId ? { checkoutId } : {}),
        status: 'sent',
      },
    });

    if (existing) {
      logger.info('Skipping duplicate email (already sent)', {
        emailType,
        orderId,
        checkoutId,
        existingLogId: existing.id,
      });
      return { skipped: true, reason: 'Already sent' };
    }

    // ── Check unsubscribe ──────────────────────────────────────
    const customer = await prisma.customer.findUnique({ where: { email: to } });
    if (customer?.unsubscribed) {
      logger.info('Skipping email to unsubscribed customer', { email: to, emailType });
      return { skipped: true, reason: 'Unsubscribed' };
    }

    // ── Send the email ─────────────────────────────────────────
    let providerMessageId;
    try {
      const result = await sendEmail({ emailType, to, data });
      providerMessageId = result.id;
    } catch (err) {
      // Log failed attempt; BullMQ will retry per job options
      await prisma.emailLog.upsert({
        where: {
          // Use a deterministic ID for this attempt
          id: `${emailType}-${orderId || checkoutId || to}-attempt`,
        },
        create: {
          emailType,
          recipientEmail: to,
          orderId: orderId || null,
          checkoutId: checkoutId || null,
          status: 'retrying',
          attempts: job.attemptsMade + 1,
          error: err.message,
        },
        update: {
          attempts: job.attemptsMade + 1,
          error: err.message,
          status:
            job.attemptsMade + 1 >= (job.opts.attempts || 3) ? 'failed' : 'retrying',
        },
      }).catch(() => {}); // Don't fail on log errors

      throw err; // Rethrow to trigger BullMQ retry
    }

    // ── Log success ────────────────────────────────────────────
    await prisma.emailLog.create({
      data: {
        emailType,
        recipientEmail: to,
        orderId: orderId || null,
        checkoutId: checkoutId || null,
        status: 'sent',
        attempts: job.attemptsMade + 1,
        sentAt: new Date(),
        resendId: providerMessageId || null,
      },
    });

    logger.info('Email sent and logged', { emailType, to, providerMessageId });
    return { success: true, providerMessageId };
  },
  {
    connection,
    concurrency: 5, // Process up to 5 emails simultaneously
  }
);

emailWorker.on('completed', (job, result) => {
  if (!result?.skipped) {
    logger.info('Email job completed', { jobId: job.id, emailType: job.data.emailType });
  }
});

emailWorker.on('failed', (job, err) => {
  logger.error('Email job failed', {
    jobId: job?.id,
    emailType: job?.data?.emailType,
    to: job?.data?.to,
    error: err.message,
    attempt: job?.attemptsMade,
  });
});

// ─── Abandoned Cart Worker ────────────────────────────────────
//
// Processes jobs from the 'abandoned-cart' queue.
// Checks if checkout is still active, then sends the reminder email.
//

const abandonedCartWorker = new Worker(
  'abandoned-cart',
  async (job) => {
    const { checkoutId, reminderNumber } = job.data;

    logger.info('Processing abandoned cart job', { checkoutId, reminderNumber });

    // Fetch the checkout
    const checkout = await prisma.checkout.findUnique({
      where: { id: checkoutId },
    });

    if (!checkout) {
      logger.warn('Checkout not found for abandoned cart job', { checkoutId });
      return { skipped: true, reason: 'Checkout not found' };
    }

    // Only send if checkout is still active (not converted or already handled)
    if (checkout.status !== 'active' && !(checkout.status === 'abandoned' && reminderNumber === 2)) {
      logger.info('Skipping abandoned cart reminder: checkout no longer active', {
        checkoutId,
        status: checkout.status,
        reminderNumber,
      });
      return { skipped: true, reason: `Checkout status: ${checkout.status}` };
    }

    const cartItems = Array.isArray(checkout.cartItems) ? checkout.cartItems : [];

    if (reminderNumber === 1) {
      // Mark as abandoned
      await prisma.checkout.update({
        where: { id: checkoutId },
        data: { status: 'abandoned' },
      });

      // Enqueue Reminder #1
      await enqueueEmail({
        emailType: 'abandoned_cart_1',
        to: checkout.customerEmail,
        data: {
          customerName: '', // Will be pulled from customer record if available
          cartItems,
          cartTotal: checkout.totalPrice,
          currency: checkout.currency,
          checkoutUrl: checkout.checkoutUrl || config.store.url,
        },
        checkoutId,
      });

      // Schedule Reminder #2 (remaining delay = reminder2 - reminder1)
      const reminder2Delay = config.cart.reminder2DelayMs - config.cart.reminder1DelayMs;
      const reminder2Job = await scheduleAbandonedCartReminder(checkoutId, 2, reminder2Delay);

      // Store the new job ID
      await prisma.checkout.update({
        where: { id: checkoutId },
        data: { reminder2JobId: reminder2Job.id },
      });

      logger.info('Abandoned cart Reminder #1 queued; Reminder #2 scheduled', {
        checkoutId,
        reminder2Delay,
      });
    } else if (reminderNumber === 2) {
      // Enqueue Reminder #2
      await enqueueEmail({
        emailType: 'abandoned_cart_2',
        to: checkout.customerEmail,
        data: {
          customerName: '',
          cartItems,
          cartTotal: checkout.totalPrice,
          currency: checkout.currency,
          checkoutUrl: checkout.checkoutUrl || config.store.url,
          discountCode: config.cart.discountCode,
          discountText: config.cart.discountText,
        },
        checkoutId,
      });

      logger.info('Abandoned cart Reminder #2 queued', { checkoutId });
    }

    return { success: true };
  },
  { connection }
);

abandonedCartWorker.on('failed', (job, err) => {
  logger.error('Abandoned cart job failed', {
    jobId: job?.id,
    checkoutId: job?.data?.checkoutId,
    error: err.message,
  });
});

module.exports = { emailWorker, abandonedCartWorker };
