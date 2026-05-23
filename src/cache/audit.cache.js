/**
 * Audit result cache backed by Redis.
 *
 * Cache key: SHA-256 of the normalized URL — avoids key injection and keeps
 * keys at a fixed length regardless of URL complexity.
 *
 * TTL: 1 hour. Audit results become stale quickly (headers, robots.txt, and
 * content change often), so we don't cache longer than this.
 *
 * All operations are wrapped in try/catch — a cache failure must never
 * cause an audit failure.
 */

import { createHash } from 'crypto';
import { getRedisClient, isRedisReady } from './redis.client.js';

const TTL_SECONDS = 60 * 60; // 1 hour
const PREFIX      = 'pulse:v2:audit:';

function key(url) {
  return PREFIX + createHash('sha256').update(url).digest('hex');
}

export async function getCachedAudit(url) {
  if (!isRedisReady()) return null;
  try {
    const raw = await getRedisClient().get(key(url));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    parsed._cached    = true;
    parsed._cachedAt  = parsed.auditedAt;
    return parsed;
  } catch {
    return null;
  }
}

export async function setCachedAudit(url, result) {
  if (!isRedisReady()) return;
  try {
    await getRedisClient().setex(key(url), TTL_SECONDS, JSON.stringify(result));
  } catch {
    // Non-fatal — audit still succeeded, we just won't cache it
  }
}
