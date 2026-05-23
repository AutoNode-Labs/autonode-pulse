import { Router } from 'express';
import { requireApiKey }             from '../middleware/auth.js';
import { standardLimiter, asyncLimiter } from '../middleware/rateLimit.js';
import { validateAuditRequest, validateAsyncAuditRequest } from '../middleware/validate.js';
import { runAudit, runAsyncAudit, getJobStatus } from '../controllers/audit.controller.js';

const router = Router();

// Auth + rate limiting applied to all audit routes
router.use(requireApiKey);

/**
 * POST /api/v1/audit
 * Synchronous audit — blocks until complete, returns full scorecard.
 * Supports ?fresh=true to bypass cache.
 */
router.post('/audit', standardLimiter, validateAuditRequest, runAudit);

/**
 * POST /api/v1/audit/async
 * Enqueues an audit job and returns a jobId immediately (HTTP 202).
 * Result delivered via webhook (if provided) and GET /audit/jobs/:id.
 */
router.post('/audit/async', asyncLimiter, validateAsyncAuditRequest, runAsyncAudit);

/**
 * GET /api/v1/audit/jobs/:id
 * Polls an async audit job. Returns status + result when complete.
 */
router.get('/audit/jobs/:id', standardLimiter, getJobStatus);

export default router;
