/**
 * API Key authentication middleware.
 *
 * Design: opt-in via env vars so the service works out-of-the-box in dev
 * without any configuration, but hardens automatically when REQUIRE_AUTH=true
 * and API_KEYS are set.
 *
 * Keys are stored as a Set for O(1) lookup — timing is consistent regardless
 * of list length, which mitigates a mild timing oracle on key enumeration.
 * For production, consider constant-time comparison (crypto.timingSafeEqual)
 * if keys are of equal length.
 */

import { errorResponse } from '../utils/response.js';

const API_KEYS = new Set(
  (process.env.API_KEYS ?? '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)
);

const AUTH_REQUIRED = process.env.REQUIRE_AUTH === 'true';

/**
 * Attaches `req.apiKey` (string | null) for downstream use (e.g. rate limiter
 * uses it to apply a higher quota for authenticated callers).
 */
export function requireApiKey(req, res, next) {
  if (!AUTH_REQUIRED || API_KEYS.size === 0) {
    req.apiKey = null;
    return next();
  }

  const key = req.headers['x-api-key'];

  if (!key) {
    return res.status(401).json(
      errorResponse('UNAUTHORIZED', 'Missing X-API-Key header')
    );
  }

  if (!API_KEYS.has(key)) {
    return res.status(403).json(
      errorResponse('FORBIDDEN', 'Invalid API key')
    );
  }

  req.apiKey = key;
  next();
}
