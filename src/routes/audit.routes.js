import { Router } from 'express';
import { validateAuditRequest } from '../middleware/validate.js';
import { runAudit }             from '../controllers/audit.controller.js';

const router = Router();

/**
 * POST /api/v1/audit
 *
 * Accepts: { "targetUrl": "https://example.com" }
 * Returns: Pulse Score JSON scorecard
 *
 * Middleware chain: validateAuditRequest → runAudit
 *   Validation rejects malformed / unsafe input before it reaches the controller,
 *   keeping controller logic free of defensive boilerplate.
 */
router.post('/audit', validateAuditRequest, runAudit);

export default router;
