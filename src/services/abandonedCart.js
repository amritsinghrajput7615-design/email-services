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
 * Called when Shopify fires `checkouts/create` or `checkouts/update`.
 *
 * @param {object} shopifyCheckout - Raw Shopify checkout object
 */
async function handleCheckoutEvent(shopifyCheckout) {
  const {
    id,
    token,
    email,
    line_items = [],
    total_price,
    currency,
    abandoned_checkout_url,
    created_at,
    updated_at,
  } = shopifyCheckout;

  // Shopify checkout ID can be numeric; use token if available, else id
  const checkoutId = String(token || id);

  if (!email) {
    logger.debug('Skipping checkout with no email', { checkoutId });
    return;
  }

  // Normalize cart items
  const cartItems = line_items.map((item) => ({
    name: item.title || item.name,
    variantTitle: item.variant_title,
    price: item.price,
    quantity: item.quantity,
    sku: item.sku,
    imageUrl: item.image_url || item.image?.src || '',
    variantId: item.variant_id,
    productId: item.product_id,
  }));

  // Ensure customer exists (upsert)
  await prisma.customer.upsert({
    where: { email },
    create: { email, name: null },
    update: {},
  });

  // Upsert the checkout record
  const existingCheckout = await prisma.checkout.findUnique({ where: { id: checkoutId } });

  if (existingCheckout?.status === 'converted') {
    logger.debug('Ignoring update for converted checkout', { checkoutId });
    return;
  }

  await prisma.checkout.upsert({
    where: { id: checkoutId },
    create: {
      id: checkoutId,
      customerEmail: email,
      cartItems,
      totalPrice: String(total_price || '0'),
      currency: currency || 'INR',
      checkoutUrl: abandoned_checkout_url || null,
      status: 'active',
    },
    update: {
      customerEmail: email,
      cartItems,
      totalPrice: String(total_price || '0'),
      currency: currency || 'INR',
      checkoutUrl: abandoned_checkout_url || null,
      status: 'active', // Reset to active on update (customer came back)
    },
  });

  logger.info('Checkout upserted', { checkoutId, email });

  // Cancel any existing reminder jobs (reset the timer on each update)
  await cancelAbandonedCartReminders(checkoutId);

  // Schedule Reminder #1 (fires after the configured delay from NOW)
  const reminder1Job = await scheduleAbandonedCartReminder(
    checkoutId,
    1,
    config.cart.reminder1DelayMs
  );

  // Save the job ID so we can cancel it later
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
