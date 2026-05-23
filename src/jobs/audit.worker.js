/**
 * Async audit background worker.
 *
 * Runs in the same Node.js event loop as the HTTP server — no threads or
 * child processes. This works because all operations are async I/O and do not
 * block the event loop.
 *
 * Webhook delivery SSRF protection: webhook URLs are validated at job creation
 * time in the middleware. Here we additionally route delivery through the
 * SSRF-safe Axios agents so that even a validation bypass cannot reach internal
 * addresses at delivery time.
 */

import axios from 'axios';
import { Agent as HttpAgent }  from 'http';
import { Agent as HttpsAgent } from 'https';
import { ssrfSafeLookup }      from '../utils/ssrf.guard.js';

import { fetchUrl }              from '../engine/fetcher.js';
import { auditLlmReadiness }    from '../engine/llm.auditor.js';
import { auditSecurityHeaders } from '../engine/security.auditor.js';
import { auditEnterpriseSeo }   from '../engine/seo.auditor.js';
import { auditTechnicalSeo }    from '../engine/technical.auditor.js';
import { calculatePulseScore }  from '../engine/scorer.js';
import { setCachedAudit }       from '../cache/audit.cache.js';
import { updateJob, getJob }    from './job.store.js';

// Reuse the same SSRF-safe agents for webhook delivery
const safeHttpAgent  = new HttpAgent ({ lookup: ssrfSafeLookup });
const safeHttpsAgent = new HttpsAgent({ lookup: ssrfSafeLookup });

async function deliverWebhook(webhookUrl, payload) {
  await axios.post(webhookUrl, payload, {
    httpAgent:  safeHttpAgent,
    httpsAgent: safeHttpsAgent,
    timeout:    10_000,
    headers:    { 'Content-Type': 'application/json', 'User-Agent': 'AutoNodePulse-Webhook/2.0' },
  });
}

/**
 * Processes a queued audit job end-to-end, then persists the result and
 * optionally delivers a webhook.
 *
 * Designed to be called fire-and-forget:
 *   setImmediate(() => processAuditJob(id, url).catch(console.error));
 */
export async function processAuditJob(jobId, targetUrl) {
  updateJob(jobId, { status: 'processing', startedAt: Date.now() });

  let auditResult;

  try {
    const fetchResult = await fetchUrl(targetUrl);

    const [llmResult, securityResult, seoResult, technicalResult] = await Promise.all([
      auditLlmReadiness(targetUrl, fetchResult.data),
      Promise.resolve(auditSecurityHeaders(fetchResult.headers)),
      Promise.resolve(auditEnterpriseSeo(fetchResult.data, fetchResult.headers)),
      auditTechnicalSeo(targetUrl, fetchResult.data),
    ]);

    const pulseScore = calculatePulseScore(llmResult, securityResult, seoResult, technicalResult);

    auditResult = {
      success:    true,
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

    await setCachedAudit(targetUrl, auditResult);
    updateJob(jobId, { status: 'completed', completedAt: Date.now(), result: auditResult });
  } catch (err) {
    auditResult = {
      success: false,
      error:   { code: err.code ?? 'AUDIT_ERROR', message: err.message },
    };
    updateJob(jobId, { status: 'failed', completedAt: Date.now(), error: auditResult.error });
  }

  // Webhook delivery — non-fatal on failure
  const job = getJob(jobId);
  if (job?.webhookUrl) {
    try {
      await deliverWebhook(job.webhookUrl, { jobId, ...auditResult });
    } catch (err) {
      console.warn(`[Webhook] Delivery failed for job ${jobId}: ${err.message}`);
    }
  }
}
