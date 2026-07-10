const logger = require('../utils/logger');

/**
 * Centralized Express error handler.
 * Must be registered as the LAST middleware in the app.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  logger.error('Unhandled error', {
    status,
    message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    body: req.body,
  });

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

/**
 * 404 handler — must be registered AFTER all routes.
 */
function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}

module.exports = { errorHandler, notFoundHandler };
