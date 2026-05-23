/**
 * AutoNode Pulse — Express application entry point.
 *
 * Security posture of this server itself:
 *   • helmet() adds a defensive header suite (X-Content-Type-Options,
 *     X-Frame-Options, X-XSS-Protection, Referrer-Policy, etc.) to every
 *     response — so our API doesn't fail its own security audit.
 *   • Body parser is size-capped at 50 KB to prevent request amplification.
 *   • No sensitive framework info is exposed (helmet removes X-Powered-By).
 *   • The 404 and global error handlers return structured JSON, never stack traces.
 */

import express from 'express';
import helmet  from 'helmet';
import auditRoutes from './routes/audit.routes.js';

const app  = express();
const PORT = process.env.PORT ?? 3000;

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());

// ── Body parsing ──────────────────────────────────────────────────────────────
// 50 KB cap: a JSON body with a single URL field will never approach this limit.
// The cap prevents memory exhaustion from oversized payloads.
app.use(express.json({ limit: '50kb' }));

// ── Health check ──────────────────────────────────────────────────────────────
// Intentionally placed before auth/rate-limit middleware (none in Phase 1) so
// load balancers and uptime monitors can reach it without credentials.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'autonode-pulse', version: '1.0.0' });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/v1', auditRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code:    'NOT_FOUND',
      message: `${req.method} ${req.path} is not a valid endpoint`,
    },
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
// Catches synchronous errors and any next(err) calls in downstream middleware.
// Never exposes err.stack in the response — that would be an info-leak.
app.use((err, _req, res, _next) => {
  console.error('[UNHANDLED_ERROR]', err);
  res.status(500).json({
    success: false,
    error: {
      code:    'INTERNAL_ERROR',
      message: 'An unexpected server error occurred. Please try again.',
    },
  });
});

app.listen(PORT, () => {
  console.log(`AutoNode Pulse listening on port ${PORT}`);
  console.log(`Endpoint: POST http://localhost:${PORT}/api/v1/audit`);
});

export default app;
