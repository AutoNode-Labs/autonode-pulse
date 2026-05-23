/**
 * Input validation middleware — Phase 2.
 *
 * Exports two validators:
 *   validateAuditRequest       — for POST /audit (sync)
 *   validateAsyncAuditRequest  — for POST /audit/async (adds optional webhookUrl)
 *
 * Webhook URL validation runs the same SSRF checks as targetUrl so that a
 * malicious webhookUrl cannot be used to exfiltrate data from internal services
 * at delivery time.
 */

import { errorResponse } from '../utils/response.js';
import { isPrivateIp }   from '../utils/ssrf.guard.js';

const ALLOWED_PROTOCOLS       = new Set(['http:', 'https:']);
const WEBHOOK_PROTOCOLS       = new Set(['https:']); // webhooks must use HTTPS
const MAX_URL_LENGTH          = 2048;
const FAST_PATH_LOCAL_PATTERN = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\])$/i;
const IPV4_PATTERN            = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function parseAndValidateUrl(raw, allowedProtocols, fieldName) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { error: `"${fieldName}" must be a non-empty string` };
  }

  const trimmed = raw.trim();

  if (trimmed.length > MAX_URL_LENGTH) {
    return { error: `"${fieldName}" exceeds the maximum allowed length of ${MAX_URL_LENGTH} characters` };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: `"${fieldName}" is not a valid URL: "${trimmed}"` };
  }

  if (!allowedProtocols.has(parsed.protocol)) {
    const allowed = [...allowedProtocols].map(p => p.replace(':', '')).join('" or "');
    return { error: `"${fieldName}" protocol must be "${allowed}". Received: "${parsed.protocol.replace(':', '')}"` };
  }

  if (FAST_PATH_LOCAL_PATTERN.test(parsed.hostname)) {
    return { ssrf: true, error: `Requests to "${parsed.hostname}" are not permitted` };
  }

  const rawHost = parsed.hostname.replace(/^\[|\]$/g, '');
  if (IPV4_PATTERN.test(rawHost) && isPrivateIp(rawHost, 4)) {
    return { ssrf: true, error: `Requests to the IP address "${rawHost}" are not permitted` };
  }
  if (rawHost.includes(':') && isPrivateIp(rawHost, 6)) {
    return { ssrf: true, error: `Requests to the IP address "${rawHost}" are not permitted` };
  }

  return { url: trimmed };
}

export function validateAuditRequest(req, res, next) {
  const { targetUrl } = req.body ?? {};

  if (targetUrl === undefined || targetUrl === null) {
    return res.status(400).json(errorResponse('VALIDATION_ERROR', 'Missing required field: "targetUrl"'));
  }

  const result = parseAndValidateUrl(targetUrl, ALLOWED_PROTOCOLS, 'targetUrl');

  if (result.error) {
    return res.status(result.ssrf ? 403 : 400).json(
      errorResponse(result.ssrf ? 'SSRF_BLOCKED' : 'VALIDATION_ERROR', result.error)
    );
  }

  req.body.targetUrl = result.url;
  next();
}

export function validateAsyncAuditRequest(req, res, next) {
  const { targetUrl, webhookUrl } = req.body ?? {};

  if (targetUrl === undefined || targetUrl === null) {
    return res.status(400).json(errorResponse('VALIDATION_ERROR', 'Missing required field: "targetUrl"'));
  }

  const targetResult = parseAndValidateUrl(targetUrl, ALLOWED_PROTOCOLS, 'targetUrl');
  if (targetResult.error) {
    return res.status(targetResult.ssrf ? 403 : 400).json(
      errorResponse(targetResult.ssrf ? 'SSRF_BLOCKED' : 'VALIDATION_ERROR', targetResult.error)
    );
  }

  if (webhookUrl !== undefined && webhookUrl !== null) {
    const webhookResult = parseAndValidateUrl(webhookUrl, WEBHOOK_PROTOCOLS, 'webhookUrl');
    if (webhookResult.error) {
      return res.status(webhookResult.ssrf ? 403 : 400).json(
        errorResponse(webhookResult.ssrf ? 'SSRF_BLOCKED' : 'VALIDATION_ERROR', webhookResult.error)
      );
    }
    req.body.webhookUrl = webhookResult.url;
  }

  req.body.targetUrl = targetResult.url;
  next();
}
