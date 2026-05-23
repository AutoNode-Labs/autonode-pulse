/**
 * Rate limiting configuration.
 *
 * Two tiers:
 *   Anonymous (IP-based): 10 req/min  — protects against casual scraping
 *   Authenticated (API key): 60 req/min — enterprise tier
 *
 * Async audits have a separate, tighter limit because each spawns a background
 * job that performs multiple external fetches (page + robots.txt + sitemap).
 *
 * express-rate-limit uses an in-memory store by default. For multi-instance
 * deployments, swap to RedisStore (rate-limit-redis) using the same Redis
 * client from cache/redis.client.js.
 */

import rateLimit from 'express-rate-limit';

const rateLimitResponse = (code, message) => ({
  success: false,
  error: { code, message },
});

export const standardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => (req.apiKey ? 60 : 10),
  keyGenerator: (req) => req.apiKey ?? req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitResponse(
    'RATE_LIMITED',
    'Too many requests — authenticated clients get 60 req/min, anonymous clients get 10 req/min'
  ),
});

export const asyncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => (req.apiKey ? 20 : 3),
  keyGenerator: (req) => `async:${req.apiKey ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitResponse(
    'RATE_LIMITED',
    'Too many async audit requests — each job spawns multiple background fetches'
  ),
});
