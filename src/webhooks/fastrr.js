const express = require('express');
const prisma = require('../db/client');
const { handleCheckoutEvent } = require('../services/abandonedCart');
const config = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

// ─── Webhook Log Helper ───────────────────────────────────────
//
// Returns the created row so callers can use log.id directly for status
// updates — avoids the racy findFirst re-query pattern.

async function logWebhook(topic, payload, status = 'received', error = null) {
  try {
    const log = await prisma.webhookLog.create({
      data: { source: 'fastrr', topic, payload, status, error },
    });
    return log;
  } catch (err) {
    logger.error('Failed to write Fastrr webhook log', { error: err.message });
    return null;
  }
}

// ─── POST /webhooks/fastrr ────────────────────────────────────
//
// Receives abandoned-cart events from the Fastrr (Shiprocket Checkout)
// dashboard. Configure in: checkout-dashboard.shiprocket.in → Webhooks →
// Abandoned Cart → set this URL + Authorization token.
//
// Auth: Bearer token in the Authorization header, compared against
// the FASTRR_WEBHOOK_TOKEN env var.

router.post('/', express.json(), async (req, res) => {
  // ─── Authentication ──────────────────────────────────────────
  const authHeader = req.headers['authorization'] || '';
  const expectedToken = config.fastrr.webhookToken;

  if (!expectedToken) {
    // Token not configured — refuse all requests loudly so misconfiguration
    // is obvious in logs rather than silently accepting unauthenticated data.
    logger.warn('Fastrr webhook received but FASTRR_WEBHOOK_TOKEN is not set — rejecting');
    return res.status(401).json({ error: 'Webhook token not configured on server.' });
  }

  const incomingToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  if (!incomingToken || incomingToken !== expectedToken) {
    logger.warn('Fastrr webhook: invalid or missing Authorization token', {
      headerPresent: !!authHeader,
    });
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const payload = req.body;
  const topic = 'abandoned_cart';

  logger.info('Fastrr webhook received', { topic });

  // Acknowledge immediately — Fastrr expects a quick 200 response
  res.status(200).json({ received: true });

  // Log the raw payload for debugging (we'll inspect real payloads here to
  // refine field extraction until Fastrr publishes a stable schema)
  const log = await logWebhook(topic, payload);

  try {
    await handleFastrrAbandonedCart(payload);

    if (log) {
      await prisma.webhookLog.update({
        where: { id: log.id },
        data: { status: 'processed' },
      });
    }
  } catch (err) {
    logger.error('Error processing Fastrr webhook', { error: err.message, stack: err.stack });
    if (log) {
      await prisma.webhookLog.update({
        where: { id: log.id },
        data: { status: 'error', error: err.message },
      });
    }
  }
});

// ─── Fastrr payload normalizer ────────────────────────────────
//
// Fastrr's exact payload schema isn't publicly documented, so we try multiple
// plausible field names/paths for each piece of data. When real payloads come
// in they'll be stored in WebhookLog — inspect them at
// GET /api/admin/webhook-logs?source=fastrr and refine these mappings.
//
// Known Fastrr payload shapes (best guesses based on similar platforms):
//   checkout_id | cart_id | id
//   customer.email | email | buyer_email
//   customer.phone | phone | buyer_phone
//   customer.name | customer_name | buyer_name
//   line_items | items | cart_items | products
//   total_price | cart_total | amount | total
//   currency
//   checkout_url | resume_url | abandoned_checkout_url | cart_url

function normalizeFastrrPayload(payload) {
  // ── Checkout / cart ID ──────────────────────────────────────
  const checkoutId =
    payload?.checkout_id ||
    payload?.cart_id ||
    payload?.id ||
    null;

  // ── Customer email ──────────────────────────────────────────
  const email =
    payload?.customer?.email ||
    payload?.email ||
    payload?.buyer_email ||
    payload?.customer_email ||
    null;

  // ── Customer phone (informational only, not stored separately yet) ──
  const phone =
    payload?.customer?.phone ||
    payload?.phone ||
    payload?.buyer_phone ||
    null;

  // ── Customer name ────────────────────────────────────────────
  const customerName =
    payload?.customer?.name ||
    payload?.customer_name ||
    payload?.buyer_name ||
    (payload?.customer?.first_name
      ? `${payload.customer.first_name} ${payload.customer.last_name || ''}`.trim()
      : null) ||
    null;

  // ── Line items ───────────────────────────────────────────────
  const rawItems =
    payload?.line_items ||
    payload?.items ||
    payload?.cart_items ||
    payload?.products ||
    [];

  const cartItems = Array.isArray(rawItems)
    ? rawItems.map((item) => ({
        name: item.name || item.title || item.product_name || 'Item',
        variantTitle: item.variant_title || item.variant_name || null,
        price: String(item.price || item.selling_price || '0'),
        quantity: item.quantity || item.qty || 1,
        sku: item.sku || null,
        imageUrl: item.image_url || item.image?.src || item.thumbnail || item.image || '',
        variantId: item.variant_id || null,
        productId: item.product_id || null,
      }))
    : [];

  // ── Cart total ───────────────────────────────────────────────
  const totalPrice = String(
    payload?.total_price ??
    payload?.cart_total ??
    payload?.amount ??
    payload?.total ??
    '0'
  );

  // ── Currency ─────────────────────────────────────────────────
  const currency = payload?.currency || 'INR';

  // ── Checkout / resume URL ─────────────────────────────────────
  const checkoutUrl =
    payload?.checkout_url ||
    payload?.resume_url ||
    payload?.abandoned_checkout_url ||
    payload?.cart_url ||
    null;

  return { checkoutId, email, phone, customerName, cartItems, totalPrice, currency, checkoutUrl };
}

async function handleFastrrAbandonedCart(payload) {
  const {
    checkoutId,
    email,
    phone,
    customerName,
    cartItems,
    totalPrice,
    currency,
    checkoutUrl,
  } = normalizeFastrrPayload(payload);

  // ── Warn if critical fields are missing (don't crash — store the payload for inspection) ──
  if (!checkoutId || !email) {
    logger.warn('Fastrr webhook: missing required fields (checkoutId or email) — skipping', {
      checkoutId,
      email,
      payloadKeys: Object.keys(payload || {}),
      // Include enough of the payload to diagnose the issue in logs
      payloadSample: JSON.stringify(payload).slice(0, 500),
    });
    return;
  }

  if (cartItems.length === 0) {
    logger.warn('Fastrr webhook: no line items found in payload', {
      checkoutId,
      email,
      payloadKeys: Object.keys(payload || {}),
    });
    // Continue — we still want to send the reminder even with an empty cart display
  }

  logger.info('Fastrr abandoned cart: normalised payload', {
    checkoutId,
    email,
    phone: phone ? '***' : null, // Redact in logs
    customerName,
    itemCount: cartItems.length,
    totalPrice,
    currency,
    hasCheckoutUrl: !!checkoutUrl,
  });

  // Upsert customer name if we have it (handleCheckoutEvent only upserts email)
  if (customerName) {
    try {
      await prisma.customer.upsert({
        where: { email },
        create: { email, name: customerName },
        update: { name: customerName },
      });
    } catch (err) {
      // Non-fatal — handleCheckoutEvent will also upsert the customer
      logger.debug('Fastrr: customer name upsert failed (will retry in handleCheckoutEvent)', {
        error: err.message,
      });
    }
  }

  // Delegate to the shared abandoned-cart service using the normalised object
  await handleCheckoutEvent({
    checkoutId,
    email,
    cartItems,
    totalPrice,
    currency,
    checkoutUrl,
    source: 'fastrr',
  });

  logger.info('Fastrr abandoned cart: reminder scheduled', { checkoutId, email });
}

module.exports = router;
