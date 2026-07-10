const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// ─── Token Cache ──────────────────────────────────────────────

let cachedToken = null;
let tokenExpiresAt = null;

/**
 * Authenticates with Shiprocket and returns a JWT token.
 * Caches the token for 23 hours (Shiprocket tokens are valid for 24h).
 */
async function getToken() {
  const now = Date.now();

  if (cachedToken && tokenExpiresAt && now < tokenExpiresAt) {
    return cachedToken;
  }

  if (!config.shiprocket.email || !config.shiprocket.password) {
    throw new Error('Shiprocket credentials not configured. Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD.');
  }

  logger.info('Authenticating with Shiprocket API...');

  try {
    const response = await axios.post(`${config.shiprocket.apiBase}/auth/login`, {
      email: config.shiprocket.email,
      password: config.shiprocket.password,
    });

    cachedToken = response.data.token;
    // Expire 1 hour early to be safe (token is valid 24h, cache for 23h)
    tokenExpiresAt = now + 23 * 60 * 60 * 1000;

    logger.info('Shiprocket authentication successful');
    return cachedToken;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error('Shiprocket authentication failed', { error: msg });
    throw new Error(`Shiprocket auth failed: ${msg}`);
  }
}

/**
 * Returns an axios instance pre-configured with the Shiprocket JWT token.
 */
async function getApiClient() {
  const token = await getToken();
  return axios.create({
    baseURL: config.shiprocket.apiBase,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

// ─── Shipment Tracking ────────────────────────────────────────

/**
 * Fetches tracking info for a given AWB code.
 *
 * @param {string} awbCode
 * @returns {Promise<object>} Tracking data from Shiprocket
 */
async function trackShipment(awbCode) {
  try {
    const client = await getApiClient();
    const response = await client.get(`/courier/track/awb/${awbCode}`);
    return response.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error('Shiprocket trackShipment failed', { awbCode, error: msg });
    throw new Error(`Shiprocket tracking failed: ${msg}`);
  }
}

/**
 * Fetches tracking info for a Shiprocket shipment by shipment ID.
 *
 * @param {string} shipmentId
 * @returns {Promise<object>}
 */
async function trackShipmentById(shipmentId) {
  try {
    const client = await getApiClient();
    const response = await client.get(`/courier/track/id/${shipmentId}`);
    return response.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error('Shiprocket trackShipmentById failed', { shipmentId, error: msg });
    throw new Error(`Shiprocket tracking failed: ${msg}`);
  }
}

/**
 * Maps a Shiprocket status string to our internal ShippingStatus enum.
 *
 * Shiprocket status values vary; this maps common ones.
 *
 * @param {string} shiprocketStatus
 * @returns {'shipped'|'out_for_delivery'|'delivered'|'returned'|null}
 */
function mapShiprocketStatus(shiprocketStatus) {
  if (!shiprocketStatus) return null;

  const status = shiprocketStatus.toLowerCase();

  if (
    status.includes('shipped') ||
    status.includes('awb assigned') ||
    status.includes('pickup') ||
    status.includes('in transit') ||
    status.includes('dispatched')
  ) {
    return 'shipped';
  }

  if (status.includes('out for delivery') || status.includes('out_for_delivery')) {
    return 'out_for_delivery';
  }

  if (status.includes('delivered')) {
    return 'delivered';
  }

  if (
    status.includes('return') ||
    status.includes('rto') ||
    status.includes('undelivered') ||
    status.includes('cancelled')
  ) {
    return 'returned';
  }

  return null;
}

/**
 * Fetches all active (non-delivered) shipments from Shiprocket for polling.
 * Uses the shipments list endpoint with status filters.
 *
 * @returns {Promise<Array>}
 */
async function getActiveShipments() {
  try {
    const client = await getApiClient();
    // Fetch shipments that are in transit (not yet delivered or returned)
    const response = await client.get('/shipments', {
      params: {
        per_page: 100,
        page: 1,
      },
    });
    return response.data?.data || [];
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error('Shiprocket getActiveShipments failed', { error: msg });
    return [];
  }
}

module.exports = {
  getToken,
  trackShipment,
  trackShipmentById,
  mapShiprocketStatus,
  getActiveShipments,
};
