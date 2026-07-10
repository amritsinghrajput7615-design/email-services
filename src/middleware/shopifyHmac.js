const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Express middleware that verifies Shopify HMAC webhook signatures.
 *
 * Shopify signs every webhook with HMAC-SHA256 using your webhook secret.
 * The signature is in the X-Shopify-Hmac-Sha256 header (base64 encoded).
 *
 * IMPORTANT: This middleware must receive the RAW request body (Buffer),
 * so it must be applied BEFORE express.json() on webhook routes.
 * We use express.raw() on the /webhooks/shopify router.
 */
function verifyShopifyHmac(req, res, next) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  if (!hmacHeader) {
    logger.warn('Shopify webhook missing HMAC header', { path: req.path });
    return res.status(401).json({ error: 'Missing HMAC signature' });
  }

  const rawBody = req.body; // Buffer from express.raw()
  if (!Buffer.isBuffer(rawBody)) {
    logger.error('Shopify HMAC verification: body is not a Buffer. Ensure express.raw() is used on this route.');
    return res.status(500).json({ error: 'Internal error: body not buffered' });
  }

  const secret = config.shopify.webhookSecret;
  const hash = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  const trusted = Buffer.from(hash);
  const received = Buffer.from(hmacHeader);

  // Use timingSafeEqual to prevent timing attacks
  if (trusted.length !== received.length || !crypto.timingSafeEqual(trusted, received)) {
    logger.warn('Shopify HMAC verification FAILED', {
      path: req.path,
      topic: req.headers['x-shopify-topic'],
    });
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  // Parse JSON body for downstream handlers
  try {
    req.shopifyPayload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.error('Failed to parse Shopify webhook payload as JSON', { error: err.message });
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  next();
}

module.exports = { verifyShopifyHmac };
