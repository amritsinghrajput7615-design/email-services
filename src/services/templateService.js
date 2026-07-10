const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const config = require('../config');
const logger = require('../utils/logger');

// Cache compiled templates in memory
const compiledTemplates = {};

// ─── Handlebars Helpers ─────────────────────────────────────

Handlebars.registerHelper('formatCurrency', function (amount, currency) {
  const num = parseFloat(amount || 0);
  const cur = currency || 'INR';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur }).format(num);
  } catch {
    return `${cur} ${num.toFixed(2)}`;
  }
});

Handlebars.registerHelper('ifCond', function (v1, operator, v2, options) {
  switch (operator) {
    case '==': return v1 == v2 ? options.fn(this) : options.inverse(this);
    case '===': return v1 === v2 ? options.fn(this) : options.inverse(this);
    case '!=': return v1 != v2 ? options.fn(this) : options.inverse(this);
    case '>': return v1 > v2 ? options.fn(this) : options.inverse(this);
    case '<': return v1 < v2 ? options.fn(this) : options.inverse(this);
    default: return options.inverse(this);
  }
});

Handlebars.registerHelper('limit', function (arr, limit) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, limit);
});

// ─── Template Loader ─────────────────────────────────────────

/**
 * Loads and compiles an HTML template file.
 * Templates are cached after first load.
 *
 * @param {string} templateName - Filename without .html extension
 * @returns {Function} Handlebars compiled template function
 */
function getTemplate(templateName) {
  if (!compiledTemplates[templateName]) {
    const filePath = path.join(__dirname, '../templates', `${templateName}.html`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Email template not found: ${templateName} (${filePath})`);
    }
    const source = fs.readFileSync(filePath, 'utf-8');
    compiledTemplates[templateName] = Handlebars.compile(source);
    logger.debug('Compiled email template', { templateName });
  }
  return compiledTemplates[templateName];
}

/**
 * Renders an email template to an HTML string.
 *
 * @param {string} templateName - Template key (e.g. "order_confirmation")
 * @param {object} data - Dynamic data to inject into the template
 * @returns {string} Rendered HTML string
 */
function renderTemplate(templateName, data) {
  const template = getTemplate(templateName);

  const baseData = {
    storeName: config.store.name,
    storeUrl: config.store.url,
    storeLogoUrl: config.store.logoUrl,
    storeAddress: config.store.address,
    storeSupportEmail: config.store.supportEmail,
    currentYear: new Date().getFullYear(),
    // Unsubscribe URL is added by emailService.js with the recipient's email encoded
    ...data,
  };

  return template(baseData);
}

/**
 * Clears the template cache (useful in development).
 */
function clearTemplateCache() {
  Object.keys(compiledTemplates).forEach((k) => delete compiledTemplates[k]);
}

module.exports = { renderTemplate, clearTemplateCache };
