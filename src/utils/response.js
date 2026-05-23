/**
 * Standardized response envelope.
 *
 * All API responses share the same top-level shape so that clients can
 * pattern-match on `success` without inspecting HTTP status codes.
 */

export function successResponse(data) {
  return {
    success: true,
    ...data,
  };
}

/**
 * @param {string} code    - Machine-readable error code (e.g. 'SSRF_BLOCKED').
 * @param {string} message - Human-readable description.
 * @param {object} [meta]  - Optional extra context (e.g. { targetUrl }).
 */
export function errorResponse(code, message, meta = {}) {
  return {
    success: false,
    error: {
      code,
      message,
      ...meta,
    },
  };
}
