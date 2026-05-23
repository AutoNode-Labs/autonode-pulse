/**
 * Redis client singleton with graceful degradation.
 *
 * If Redis is unavailable the service continues to operate — cache misses
 * are silently swallowed and audits run fresh every time. This means Redis
 * is an optimisation layer, not a hard dependency.
 *
 * lazyConnect: true  — avoids throwing at import time if Redis is down.
 * enableOfflineQueue: false — commands fail immediately instead of queuing
 *   indefinitely, which would cause memory leaks under sustained outage.
 */

import Redis from 'ioredis';

let client = null;
let _ready = false;

export function getRedisClient() {
  if (client) return client;

  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

  client = new Redis(url, {
    lazyConnect:          true,
    enableOfflineQueue:   false,
    maxRetriesPerRequest: 1,
    connectTimeout:       3_000,
  });

  client.on('ready',  () => { _ready = true;  console.log('[Redis] Connected'); });
  client.on('close',  () => { _ready = false; });
  client.on('error',  (err) => {
    if (_ready) console.warn('[Redis] Error — cache disabled:', err.message);
    _ready = false;
  });

  // Fire-and-forget — failure is expected in dev without Redis
  client.connect().catch(() => {
    console.warn('[Redis] Not available — audit results will not be cached');
  });

  return client;
}

export const isRedisReady = () => _ready;
