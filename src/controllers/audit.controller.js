/**
 * Audit Controller — orchestrates the full audit pipeline.
 *
 * Pipeline stages:
 *   1. Fetch the target URL (SSRF-safe, with robots.txt fetched in parallel by the LLM auditor)
 *   2. Run the three auditors concurrently (they are independent given the fetched HTML)
 *   3. Compute the composite Pulse Score
 *   4. Return the structured JSON scorecard
 *
 * Error handling strategy:
 *   • SSRF / DNS / timeout errors from the fetcher → specific HTTP codes + codes
 *   • Auditor errors → should not propagate (auditors are designed to return partial
 *     results rather than throw); if one does throw, the global handler catches it
 */

import { fetchUrl }              from '../engine/fetcher.js';
import { auditLlmReadiness }    from '../engine/llm.auditor.js';
import { auditSecurityHeaders } from '../engine/security.auditor.js';
import { auditEnterpriseSeo }   from '../engine/seo.auditor.js';
import { calculatePulseScore }  from '../engine/scorer.js';
import { successResponse, errorResponse } from '../utils/response.js';

export async function runAudit(req, res) {
  const { targetUrl } = req.body;

  // ── Stage 1: Fetch the target page ────────────────────────────────────────
  let fetchResult;
  try {
    fetchResult = await fetchUrl(targetUrl);
  } catch (err) {
    switch (err.code) {
      case 'SSRF_BLOCKED':
        return res.status(403).json(
          errorResponse('SSRF_BLOCKED',
            'Request blocked: the target URL resolves to a private or reserved IP address.',
            { targetUrl })
        );
      case 'FETCH_TIMEOUT':
        return res.status(504).json(
          errorResponse('FETCH_TIMEOUT',
            'The target URL did not respond within the allowed time window.',
            { targetUrl })
        );
      case 'DNS_ERROR':
        return res.status(400).json(
          errorResponse('DNS_ERROR',
            'Could not resolve the hostname in the target URL. Verify the domain exists.',
            { targetUrl })
        );
      case 'CONN_REFUSED':
        return res.status(502).json(
          errorResponse('CONN_REFUSED',
            'The target server actively refused the connection.',
            { targetUrl })
        );
      default:
        return res.status(502).json(
          errorResponse('FETCH_ERROR',
            `Failed to fetch the target URL: ${err.message}`,
            { targetUrl })
        );
    }
  }

  // ── Stage 2: Run all auditors concurrently ────────────────────────────────
  // The LLM auditor fetches robots.txt internally — this is intentional so its
  // concerns are self-contained. The security and SEO auditors are pure functions
  // over already-fetched data, so they resolve nearly instantly.
  const [llmResult, securityResult, seoResult] = await Promise.all([
    auditLlmReadiness(targetUrl, fetchResult.data),
    Promise.resolve(auditSecurityHeaders(fetchResult.headers)),
    Promise.resolve(auditEnterpriseSeo(fetchResult.data, fetchResult.headers)),
  ]);

  // ── Stage 3: Calculate composite score ───────────────────────────────────
  const pulseScore = calculatePulseScore(llmResult, securityResult, seoResult);

  // ── Stage 4: Return structured scorecard ─────────────────────────────────
  return res.status(200).json(
    successResponse({
      targetUrl,
      finalUrl:   fetchResult.finalUrl,   // Actual URL after any redirects
      httpStatus: fetchResult.status,
      auditedAt:  new Date().toISOString(),
      pulseScore,
      categories: {
        llmReadiness:  llmResult,
        security:      securityResult,
        enterpriseSeo: seoResult,
      },
    })
  );
}
