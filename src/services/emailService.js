const { Resend } = require('resend');
const sgMail = require('@sendgrid/mail');
const config = require('../config');
const { renderTemplate } = require('./templateService');
const logger = require('../utils/logger');

// ─── Email Subjects by Type ──────────────────────────────────

const EMAIL_SUBJECTS = {
  abandoned_cart_1: `You left something behind 🛒`,
  abandoned_cart_2: `Still thinking? Here's a special offer 💸`,
  order_confirmation: (data) => `Order Confirmed! ${data.orderNumber || ''}`,
  order_shipped: (data) => `Your order ${data.orderNumber || ''} is on its way! 🚚`,
  out_for_delivery: (data) => `Your order ${data.orderNumber || ''} is out for delivery today 📦`,
  delivered: (data) => `Your order ${data.orderNumber || ''} has been delivered 🎉`,
  refund_completed: (data) => `Your refund has been processed ✅`,
};

function getSubject(emailType, data) {
  const subj = EMAIL_SUBJECTS[emailType];
  if (!subj) return emailType;
  return typeof subj === 'function' ? subj(data) : subj;
}

// ─── Provider Clients ─────────────────────────────────────────

let resendClient;
function getResendClient() {
  if (!resendClient) {
    if (!config.email.resendApiKey) throw new Error('RESEND_API_KEY is not set');
    resendClient = new Resend(config.email.resendApiKey);
  }
  return resendClient;
}

function initSendGrid() {
  if (!config.email.sendgridApiKey) throw new Error('SENDGRID_API_KEY is not set');
  sgMail.setApiKey(config.email.sendgridApiKey);
}

// ─── Unsubscribe URL Generator ────────────────────────────────

function buildUnsubscribeUrl(email) {
  const encoded = Buffer.from(email).toString('base64url');
  return `${config.appUrl}/unsubscribe?token=${encoded}`;
}

// ─── Core Send Function ───────────────────────────────────────

/**
 * Renders and sends a single email.
 *
 * @param {object} params
 * @param {string} params.emailType   - Template name key
 * @param {string} params.to          - Recipient email address
 * @param {object} params.data        - Template data
 * @param {string} [params.subject]   - Override subject (optional)
 * @returns {Promise<{ id: string }>}  Provider message ID
 */
async function sendEmail({ emailType, to, data = {}, subject: overrideSubject }) {
  const subject = overrideSubject || getSubject(emailType, data);

  // Inject unsubscribe URL into template data
  const templateData = {
    ...data,
    unsubscribeUrl: buildUnsubscribeUrl(to),
  };

  const html = renderTemplate(emailType, templateData);

  const fromAddress = `${config.email.fromName} <${config.email.from}>`;

  logger.info('Sending email', { emailType, to, subject, provider: config.email.provider });

  if (config.email.provider === 'sendgrid') {
    initSendGrid();
    const msg = {
      to,
      from: { email: config.email.from, name: config.email.fromName },
      subject,
      html,
    };
    const [response] = await sgMail.send(msg);
    const messageId = response.headers['x-message-id'] || `sg-${Date.now()}`;
    logger.info('Email sent via SendGrid', { messageId, to, emailType });
    return { id: messageId };
  } else {
    // Default: Resend
    const client = getResendClient();
    const result = await client.emails.send({
      from: fromAddress,
      to: [to],
      subject,
      html,
    });
    if (result.error) {
      throw new Error(`Resend API error: ${result.error.message}`);
    }
    logger.info('Email sent via Resend', { messageId: result.data?.id, to, emailType });
    return { id: result.data?.id || `resend-${Date.now()}` };
  }
}

module.exports = { sendEmail, buildUnsubscribeUrl };
