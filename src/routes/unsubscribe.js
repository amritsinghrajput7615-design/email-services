const express = require('express');
const prisma = require('../db/client');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /unsubscribe?token=<base64url-encoded-email>
 *
 * Handles one-click unsubscribe links included in every email.
 * Decodes the token, marks the customer as unsubscribed, and
 * shows a confirmation page.
 *
 * The token is base64url-encoded email address (not secret, just obfuscated).
 * For production, consider signing with HMAC for tamper-proof links.
 */
router.get('/', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send(unsubscribePage('Invalid unsubscribe link.', false));
  }

  let email;
  try {
    email = Buffer.from(token, 'base64url').toString('utf-8');
    if (!email.includes('@')) throw new Error('Invalid email');
  } catch {
    return res.status(400).send(unsubscribePage('Invalid unsubscribe link.', false));
  }

  try {
    await prisma.customer.upsert({
      where: { email },
      create: { email, unsubscribed: true, unsubscribedAt: new Date() },
      update: { unsubscribed: true, unsubscribedAt: new Date() },
    });

    logger.info('Customer unsubscribed', { email });
    return res.send(unsubscribePage(`You've been unsubscribed. You will no longer receive marketing emails from us.`, true));
  } catch (err) {
    logger.error('Unsubscribe error', { error: err.message, email });
    return res.status(500).send(unsubscribePage('Something went wrong. Please try again later.', false));
  }
});

/**
 * POST /unsubscribe/resubscribe
 * Allows a customer to re-subscribe if they change their mind.
 */
router.post('/resubscribe', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    await prisma.customer.update({
      where: { email },
      data: { unsubscribed: false, unsubscribedAt: null },
    });
    logger.info('Customer re-subscribed', { email });
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: 'Customer not found' });
  }
});

// ─── Minimal HTML Confirmation Page ───────────────────────────

function unsubscribePage(message, success) {
  const storeName = process.env.STORE_NAME || 'Your Store';
  const color = success ? '#10B981' : '#EF4444';
  const icon = success ? '✅' : '❌';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribe — ${storeName}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', sans-serif; background: #f4f4f8; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 16px; padding: 48px 40px; max-width: 480px; width: 90%; text-align: center; box-shadow: 0 4px 32px rgba(0,0,0,0.08); }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; font-weight: 600; color: #111; margin-bottom: 12px; }
    p { color: #555; line-height: 1.6; }
    .store { margin-top: 32px; font-size: 12px; color: #999; }
    a { color: ${color}; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${success ? 'Successfully Unsubscribed' : 'Oops!'}</h1>
    <p>${message}</p>
    <p class="store">&copy; ${new Date().getFullYear()} ${storeName}</p>
  </div>
</body>
</html>`;
}

module.exports = router;
