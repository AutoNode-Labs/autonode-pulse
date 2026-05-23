/**
 * AutoNode Pulse — Express server entry point (Phase 2).
 */

import express from 'express';
import helmet  from 'helmet';
import { getRedisClient } from './cache/redis.client.js';
import auditRoutes from './routes/audit.routes.js';

const app  = express();
const PORT = process.env.PORT ?? 3000;

// Initialise Redis eagerly so the first request isn't penalised by the
// connection handshake. Failure is logged but does not abort startup.
getRedisClient();

app.use(helmet());
app.use(express.json({ limit: '50kb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'autonode-pulse', version: '2.0.0' });
});

app.use('/api/v1', auditRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} is not a valid endpoint` },
  });
});

app.use((err, _req, res, _next) => {
  console.error('[UNHANDLED_ERROR]', err);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred' },
  });
});

app.listen(PORT, () => {
  console.log(`AutoNode Pulse v2 listening on port ${PORT}`);
  console.log(`Sync:  POST http://localhost:${PORT}/api/v1/audit`);
  console.log(`Async: POST http://localhost:${PORT}/api/v1/audit/async`);
  console.log(`Jobs:  GET  http://localhost:${PORT}/api/v1/audit/jobs/:id`);
});

export default app;
