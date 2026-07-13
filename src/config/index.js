require('dotenv').config();

/**
 * Throws if a required env var is missing.
 */
function required(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`❌ Missing required environment variable: ${name}`);
  }
  return val;
}

function optional(name, defaultValue = '') {
  return process.env[name] || defaultValue;
}

const config = {
  port: parseInt(optional('PORT', '3000'), 10),
  appUrl: optional('APP_URL', 'http://localhost:3000'),
  nodeEnv: optional('NODE_ENV', 'development'),

  db: {
    url: required('DATABASE_URL'),
  },

  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },

  shopify: {
    apiKey: optional('SHOPIFY_API_KEY'),
    apiSecret: optional('SHOPIFY_API_SECRET'),
    storeDomain: optional('SHOPIFY_STORE_DOMAIN'),
    // Used for HMAC signature verification of incoming webhooks
    webhookSecret: required('SHOPIFY_WEBHOOK_SECRET'),
  },

  shiprocket: {
    email: optional('SHIPROCKET_EMAIL'),
    password: optional('SHIPROCKET_PASSWORD'),
    apiBase: optional('SHIPROCKET_API_BASE', 'https://apiv2.shiprocket.in/v1/external'),
    pollIntervalMinutes: parseInt(optional('SHIPROCKET_POLL_INTERVAL_MINUTES', '30'), 10),
  },

  email: {
    provider: optional('EMAIL_PROVIDER', 'resend'), // 'resend' | 'sendgrid'
    resendApiKey: optional('RESEND_API_KEY'),
    sendgridApiKey: optional('SENDGRID_API_KEY'),
    from: optional('EMAIL_FROM', 'noreply@yourdomain.com'),
    fromName: optional('EMAIL_FROM_NAME', 'Your Store'),
  },

  store: {
    name: optional('STORE_NAME', 'Your Store'),
    url: optional('STORE_URL', 'https://yourstore.com'),
    logoUrl: optional('STORE_LOGO_URL', ''),
    address: optional('STORE_ADDRESS', '123 Main Street, City, Country'),
    supportEmail: optional('STORE_SUPPORT_EMAIL', 'support@yourstore.com'),
  },

  cart: {
    reminder1DelayMs: parseInt(optional('ABANDONED_CART_REMINDER1_DELAY_MS', '3600000'), 10),
    reminder2DelayMs: parseInt(optional('ABANDONED_CART_REMINDER2_DELAY_MS', '86400000'), 10),
    discountCode: optional('DISCOUNT_CODE', ''),
    discountText: optional('DISCOUNT_TEXT', '10% off your order'),
  },

  dashboard: {
    token: optional('DASHBOARD_TOKEN', ''),
  },

  fastrr: {
    // Bearer token Fastrr sends in the Authorization header on abandoned-cart webhooks.
    // Set this to any strong random secret, then configure the same value in the
    // Fastrr dashboard → Webhooks → Abandoned Cart → Authorization Token.
    webhookToken: optional('FASTRR_WEBHOOK_TOKEN', ''),
  },
};

module.exports = config;
