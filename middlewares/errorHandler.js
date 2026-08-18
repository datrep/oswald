const sql = require('mssql');
const { AppError } = require('../utils/errors');

// Global error handler
function globalErrorHandler(err, req, res, next) {
  // Log the error with stack trace for debugging
  console.error(`[${new Date().toISOString()}] Error:`, err);

  // If headers already sent, delegate to Express
  if (res.headersSent) {
    return next(err);
  }

  // Handle our custom AppErrors (404, 400, 401, 403, etc.)
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      // Only include stack in development
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
  }

  // Handle database errors (request, connection, and transaction failures).
  if (
    err instanceof sql.RequestError ||
    err instanceof sql.ConnectionError ||
    err instanceof sql.TransactionError
  ) {
    return res.status(500).json({
      error: 'Database Error',
      details: err.message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
  }

  // Handle Joi validation errors (if you're using Joi)
  if (err.isJoi) {
    return res.status(400).json({
      error: 'Validation Error',
      details: err.details.map((d) => d.message),
    });
  }

  // Handle everything else as 500
  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 ? 'Internal Server Error' : err.message;

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && {
      details: err.message,
      stack: err.stack,
    }),
  });
}

// 404 handler for unmatched routes
function notFoundHandler(req, res) {
  res.status(404).json({
    error: `Route ${req.method} ${req.originalUrl} not found`,
  });
}

// Unhandled rejection handler
function unhandledRejectionHandler(reason, promise) {
  console.error('Unhandled Rejection at:', promise);
  console.error('Unhandled Rejection reason:', reason);
  // Intentionally does NOT exit, so a stray rejection doesn't kill the dev server.
}

module.exports = {
  globalErrorHandler,
  notFoundHandler,
  unhandledRejectionHandler,
};
