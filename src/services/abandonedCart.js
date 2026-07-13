const prisma = require('../db/client');
const {
  scheduleAbandonedCartReminder,
  cancelAbandonedCartReminders,
} = require('../queues/emailQueue');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Upserts a checkout record in the database and reschedules the abandoned cart reminder.
 *
 * Accepts a **normalized** checkout object so it can be called from any webhook source
 * (Shopify `checkouts/create` / `checkouts/update`, Fastrr abandoned-cart, etc.)
 * without being coupled to any particular raw payload shape. The caller is responsible
 * for extracting and normalizing fields before calling this function.
 *
 * @param {object} normalized
 * @param {string}   normalized.checkoutId   - Unique checkout/cart ID (Shopify token, Fastrr cart ID, etc.)
 * @param {string}   normalized.email        - Customer email address
 * @param {object[]} normalized.cartItems    - Array of { name, price, quantity, sku, imageUrl, variantId?, productId? }
 * @param {string}   normalized.totalPrice   - Cart total as a string
 * @param {string}   normalized.currency     - ISO currency code (default: 'INR')
 * @param {string|null} normalized.checkoutUrl - Resume / abandoned checkout URL
 * @param {string}   normalized.source       - Originating source: 'shopify' | 'fastrr'
 */
async function handleCheckoutEvent(normalized) {
  const {
    checkoutId,
    email,
    cartItems = [],
    totalPrice = '0',
    currency = 'INR',
    checkoutUrl = null,
    source = 'shopify',
  } = normalized;

  if (!email) {
    logger.debug('Skipping checkout with no email', { checkoutId, source });
    return;
  }

  if (!checkoutId) {
    logger.warn('Skipping checkout with no ID', { email, source });
    return;
  }

  // Ensure customer exists (upsert)
  await prisma.customer.upsert({
    where: { email },
    create: { email, name: null },
    update: {},
  });

  // Skip if checkout was already converted (e.g. order placed during rapid Shopify updates)
  const existingCheckout = await prisma.checkout.findUnique({ where: { id: checkoutId } });

  if (existingCheckout?.status === 'converted') {
    logger.debug('Ignoring update for converted checkout', { checkoutId, source });
    return;
  }

  // Upsert the checkout record
  await prisma.checkout.upsert({
    where: { id: checkoutId },
    create: {
      id: checkoutId,
      customerEmail: email,
      cartItems,
      totalPrice: String(totalPrice),
      currency,
      checkoutUrl,
      source,
      status: 'active',
    },
    update: {
      customerEmail: email,
      cartItems,
      totalPrice: String(totalPrice),
      currency,
      checkoutUrl,
      source,
      status: 'active', // Reset to active on update (customer came back)
    },
  });

  logger.info('Checkout upserted', { checkoutId, email, source });

  // ─── Timer-reset behavior ─────────────────────────────────────────────────
  // We cancel the existing reminder job and schedule a fresh one every time
  // this function is called. This keeps the reminder window relative to the
  // LAST activity (good: catches customers who keep returning but haven't
  // completed checkout). The downside is that a customer who types slowly into
  // checkout fields may keep pushing the reminder back indefinitely.
  //
  // For Shopify this is called on every checkouts/create + checkouts/update.
  // For Fastrr this is typically called once per webhook POST (Fastrr batches
  // its abandoned-cart events), so repeated deferrals are less of a concern there.
  //
  // If you want to change this: only reschedule when cartItems actually changed,
  // or only reschedule if the existing job's remaining delay is below a minimum
  // threshold (e.g. 30 minutes).
  // ─────────────────────────────────────────────────────────────────────────

  // Cancel any existing reminder jobs (reset the timer on each update)
  await cancelAbandonedCartReminders(checkoutId);

  // Schedule Reminder #1 (fires after the configured delay from NOW)
  const reminder1Job = await scheduleAbandonedCartReminder(
    checkoutId,
    1,
    config.cart.reminder1DelayMs
  );

  // Save the job ID so we can cancel it later if the order is placed
  await prisma.checkout.update({
    where: { id: checkoutId },
    data: { reminder1JobId: reminder1Job.id },
  });
}

/**
 * Marks a checkout as converted when an order is placed.
 * Cancels any pending abandoned cart reminder jobs.
 *
 * @param {string|number} shopifyCheckoutId - The checkout_id from the order
 */
async function markCheckoutConverted(shopifyCheckoutId) {
  if (!shopifyCheckoutId) return;

  const checkoutId = String(shopifyCheckoutId);

  const checkout = await prisma.checkout.findUnique({ where: { id: checkoutId } });
  if (!checkout) {
    logger.debug('No checkout found to mark converted', { checkoutId });
    return;
  }

  // Cancel pending reminder jobs
  await cancelAbandonedCartReminders(checkoutId);

  // Update status
  await prisma.checkout.update({
    where: { id: checkoutId },
    data: { status: 'converted' },
  });

  logger.info('Checkout marked as converted', { checkoutId });
}

module.exports = { handleCheckoutEvent, markCheckoutConverted };
