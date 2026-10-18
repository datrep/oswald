// shared/rateLimit.js — lightweight in-memory per-IP rate limiter for
// unauthenticated endpoints (login/register). No external dependency; each
// service keeps its own map, so state resets on restart (fine for a
// single-process deployment).

function rateLimit({ windowMs = 60 * 1000, max = 30, message = 'Too many requests, please try again later.' } = {}) {
  const hits = new Map();

  // Sweep expired buckets periodically so the map doesn't grow unbounded.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of hits) {
      if (now - bucket.start >= windowMs) hits.delete(key);
    }
  }, windowMs);
  if (typeof timer.unref === 'function') timer.unref();

  return function rateLimitMiddleware(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = hits.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// Preconfigured limiters, shared by the dashboard and fileserver so the same
// thresholds apply everywhere.
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many login attempts, please try again later.',
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many account creations, please try again later.',
});

module.exports = { rateLimit, loginLimiter, registerLimiter };
