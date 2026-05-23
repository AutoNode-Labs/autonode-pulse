/**
 * Input validation middleware for the audit endpoint.
 *
 * Architectural decision: validation at the boundary (before any business logic)
 * follows the principle that only data that has passed schema checks should enter
 * the system. We reject early, loudly, and with specific error codes rather than
 * letting malformed data propagate and produce cryptic downstream errors.
 *
 * We also do a fast-path hostname block for obvious loopback addresses before
 * the request reaches the SSRF guard. The SSRF guard would catch these anyway,
 * but catching them here produces a clearer error message and avoids a DNS lookup.
 */

import { errorResponse } from '../utils/response.js';
import { isPrivateIp }   from '../utils/ssrf.guard.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_URL_LENGTH = 2048;

// Hostnames/patterns that are obviously local and should be rejected at the
// input layer before we even attempt DNS resolution.
const FAST_PATH_LOCAL_PATTERN = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\])$/i;

// Matches a bare IPv4 address as the URL hostname (e.g. "10.0.0.1").
// IPv6 in URLs appears as "[::1]" — we strip the brackets for the IP check.
const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function validateAuditRequest(req, res, next) {
  const { targetUrl } = req.body ?? {};

  if (targetUrl === undefined || targetUrl === null) {
    return res.status(400).json(
      errorResponse('VALIDATION_ERROR', 'Missing required field: "targetUrl"')
    );
  }

  if (typeof targetUrl !== 'string') {
    return res.status(400).json(
      errorResponse('VALIDATION_ERROR', '"targetUrl" must be a string')
    );
  }

  const trimmed = targetUrl.trim();

  if (trimmed.length === 0) {
    return res.status(400).json(
      errorResponse('VALIDATION_ERROR', '"targetUrl" must not be empty')
    );
  }

  if (trimmed.length > MAX_URL_LENGTH) {
    return res.status(400).json(
      errorResponse('VALIDATION_ERROR', `"targetUrl" exceeds the maximum allowed length of ${MAX_URL_LENGTH} characters`)
    );
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return res.status(400).json(
      errorResponse('VALIDATION_ERROR', `"targetUrl" is not a valid URL: "${trimmed}"`)
    );
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return res.status(400).json(
      errorResponse(
        'VALIDATION_ERROR',
        `"targetUrl" protocol must be "http" or "https". Received: "${parsed.protocol.replace(':', '')}"`
      )
    );
  }

  // Fast-path loopback rejection — provides a clearer error than the SSRF guard.
  if (FAST_PATH_LOCAL_PATTERN.test(parsed.hostname)) {
    return res.status(403).json(
      errorResponse('SSRF_BLOCKED', `Requests to "${parsed.hostname}" are not permitted`)
    );
  }

  // If the hostname is a literal IP address, validate it immediately.
  // DNS lookup hooks only fire for hostnames, not literal IPs — so without this
  // check, `http://10.0.0.1/` would bypass the SSRF guard entirely.
  const rawHost = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (IPV4_PATTERN.test(rawHost)) {
    if (isPrivateIp(rawHost, 4)) {
      return res.status(403).json(
        errorResponse('SSRF_BLOCKED', `Requests to the IP address "${rawHost}" are not permitted`)
      );
    }
  } else if (rawHost.includes(':')) {
    // IPv6 literal — validate against private IPv6 ranges.
    if (isPrivateIp(rawHost, 6)) {
      return res.status(403).json(
        errorResponse('SSRF_BLOCKED', `Requests to the IP address "${rawHost}" are not permitted`)
      );
    }
  }

  // Attach the normalized (trimmed) URL back for use in downstream handlers.
  req.body.targetUrl = trimmed;
  next();
}
