/**
 * Audit Controller — Phase 2.
 *
 * Exposes two audit modes:
 *   runAudit      → synchronous, checks cache first, blocks until complete
 *   runAsyncAudit → returns a jobId immediately, audit runs in background,
 *                   result delivered via webhook (if provided) and GET /jobs/:id
 *   getJobStatus  → polls an async job by ID
 *
 * Cache strategy (sync endpoint only):
 *   1. Cache hit  → return cached result with _cached: true flag (< 1 ms)
 *   2. Cache miss → run full audit, store result, return fresh result
 *
 * The async endpoint never reads from cache on submission (caller wants a fresh
 * audit), but the worker writes its result to cache so subsequent sync calls
 * for the same URL benefit.
 */

import { fetchUrl }              from '../engine/fetcher.js';
import { auditLlmReadiness }    from '../engine/llm.auditor.js';
import { auditSecurityHeaders } from '../engine/security.auditor.js';
import { auditEnterpriseSeo }   from '../engine/seo.auditor.js';
import { auditTechnicalSeo }    from '../engine/technical.auditor.js';
import { calculatePulseScore }  from '../engine/scorer.js';
import { getCachedAudit, setCachedAudit } from '../cache/audit.cache.js';
import { createJob, getJob }    from '../jobs/job.store.js';
import { processAuditJob }      from '../jobs/audit.worker.js';
import { successResponse, errorResponse } from '../utils/response.js';

// ── Shared fetch-error mapper ─────────────────────────────────────────────────
function handleFetchError(err, targetUrl, res) {
  const map = {
    SSRF_BLOCKED:  { status: 403,  code: 'SSRF_BLOCKED',  msg: 'Request blocked: target URL resolves to a private or reserved IP address.' },
    FETCH_TIMEOUT: { status: 504,  code: 'FETCH_TIMEOUT',  msg: 'Target URL did not respond within the allowed time window.' },
    DNS_ERROR:     { status: 400,  code: 'DNS_ERROR',      msg: 'Could not resolve the hostname in the target URL.' },
    CONN_REFUSED:  { status: 502,  code: 'CONN_REFUSED',   msg: 'Target server actively refused the connection.' },
  };
  const mapped = map[err.code];
  if (mapped) {
    return res.status(mapped.status).json(errorResponse(mapped.code, mapped.msg, { targetUrl }));
  }
  return res.status(502).json(errorResponse('FETCH_ERROR', `Failed to fetch target URL: ${err.message}`, { targetUrl }));
}

// ── Sync audit ────────────────────────────────────────────────────────────────
export async function runAudit(req, res) {
  const { targetUrl } = req.body;

  // Cache check — bypass with ?fresh=true for explicit cache invalidation
  if (req.query.fresh !== 'true') {
    const cached = await getCachedAudit(targetUrl);
    if (cached) return res.status(200).json(successResponse(cached));
  }

  let fetchResult;
  try {
    fetchResult = await fetchUrl(targetUrl);
  } catch (err) {
    return handleFetchError(err, targetUrl, res);
  }

  const [llmResult, securityResult, seoResult, technicalResult] = await Promise.all([
    auditLlmReadiness(targetUrl, fetchResult.data),
    Promise.resolve(auditSecurityHeaders(fetchResult.headers)),
    Promise.resolve(auditEnterpriseSeo(fetchResult.data, fetchResult.headers)),
    auditTechnicalSeo(targetUrl, fetchResult.data),
  ]);

  const pulseScore = calculatePulseScore(llmResult, securityResult, seoResult, technicalResult);

  const result = {
    targetUrl,
    finalUrl:   fetchResult.finalUrl,
    httpStatus: fetchResult.status,
    auditedAt:  new Date().toISOString(),
    pulseScore,
    categories: {
      llmReadiness:  llmResult,
      security:      securityResult,
      enterpriseSeo: seoResult,
      technicalSeo:  technicalResult,
    },
  };

  await setCachedAudit(targetUrl, result);
  return res.status(200).json(successResponse(result));
}

// ── Async audit ───────────────────────────────────────────────────────────────
export async function runAsyncAudit(req, res) {
  const { targetUrl, webhookUrl = null } = req.body;

  const jobId = createJob(targetUrl, webhookUrl);

  // Fire-and-forget — do not await; response is sent immediately
  setImmediate(() => processAuditJob(jobId, targetUrl).catch(
    (err) => console.error(`[Worker] Unhandled error in job ${jobId}:`, err)
  ));

  return res.status(202).json(
    successResponse({
      jobId,
      status:     'queued',
      targetUrl,
      webhookUrl,
      statusUrl:  `/api/v1/audit/jobs/${jobId}`,
      message:    'Audit queued. Poll statusUrl or wait for webhook delivery.',
    })
  );
}

// ── Job status ────────────────────────────────────────────────────────────────
export function getJobStatus(req, res) {
  const { id } = req.params;
  const job = getJob(id);

  if (!job) {
    return res.status(404).json(
      errorResponse('JOB_NOT_FOUND', `No job found with ID "${id}"`)
    );
  }

  const { result, error, ...meta } = job;

  return res.status(200).json(
    successResponse({
      ...meta,
      ...(job.status === 'completed' ? { result } : {}),
      ...(job.status === 'failed'    ? { error  } : {}),
    })
  );
}
