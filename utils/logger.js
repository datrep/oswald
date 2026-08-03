// utils/logger.js
// Simple request logging middleware.

// Endpoints that are polled frequently (and would spam the log) are skipped on success.
const SKIP_URLS = new Set(['/api/ips/check']);

function logall(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    if (SKIP_URLS.has(req.originalUrl) && res.statusCode < 400) {
      return;
    }
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
}

module.exports = logall;
