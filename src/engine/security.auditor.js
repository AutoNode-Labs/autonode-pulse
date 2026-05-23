/**
 * Security-to-SEO Header Auditor.
 *
 * Two concerns are merged here because they are causally linked:
 *   • Missing security headers (HSTS, CSP, etc.) are a direct Google ranking
 *     signal and a user-trust risk in search result snippets.
 *   • Information-leak headers (X-Powered-By, Server with version) create
 *     fingerprinting vectors that attackers use to find known CVEs.
 *
 * Scoring budget: 35 points total.
 *   Required security headers: 29 pts (sum of individual weights below)
 *   Information leak headers:  6 pts
 */

// ─── Required security header definitions ────────────────────────────────────
// `points` reflects the real-world risk weight of each header's absence.
// HSTS and CSP are weighted highest because their absence enables entire attack
// classes (protocol downgrade and XSS respectively).
const REQUIRED_HEADERS = [
  {
    name:        'strict-transport-security',
    display:     'Strict-Transport-Security',
    description: 'Forces HTTPS connections — prevents protocol downgrade and MITM attacks. Critical for Google HTTPS ranking signal.',
    points:      10,
  },
  {
    name:        'content-security-policy',
    display:     'Content-Security-Policy',
    description: 'Restricts resource origins — primary XSS and data injection mitigation.',
    points:      10,
  },
  {
    name:         'x-content-type-options',
    display:      'X-Content-Type-Options',
    description:  'Prevents MIME-type sniffing — stops browsers executing mistyped responses as scripts.',
    points:       3,
    expectedValue: 'nosniff', // Only exact value confers protection
  },
  {
    name:        'x-frame-options',
    display:     'X-Frame-Options',
    description: 'Prevents clickjacking by disallowing framing. Superseded by CSP frame-ancestors but still required for legacy browser coverage.',
    points:      3,
  },
  {
    name:        'referrer-policy',
    display:     'Referrer-Policy',
    description: 'Controls how much referrer information is sent with requests — prevents URL-encoded sensitive data leakage.',
    points:      2,
  },
  {
    name:        'permissions-policy',
    display:     'Permissions-Policy',
    description: 'Restricts browser feature access (camera, geolocation, microphone) — limits blast radius of XSS attacks.',
    points:      1,
  },
];

// ─── Information-leak header definitions ─────────────────────────────────────
// These headers, when present with version info, provide a free fingerprinting
// vector that attackers correlate against CVE databases.
const INFO_LEAK_HEADERS = [
  {
    name:           'x-powered-by',
    display:        'X-Powered-By',
    description:    'Exposes the server-side technology stack (e.g. "Express", "PHP/8.1"). Remove entirely.',
    points:         4,
    versionPattern: null, // Any presence is a leak (value is always informative)
  },
  {
    name:           'server',
    display:        'Server',
    description:    'Server header with a version string (e.g. "nginx/1.21.6") enables targeted exploitation.',
    points:         5,
    // Bare vendor name ("nginx", "Apache") earns a warning. Version string → fail.
    versionPattern: /\/[\d.]+/,
  },
  {
    name:           'x-aspnet-version',
    display:        'X-AspNet-Version',
    description:    'Exposes ASP.NET runtime version — immediate fingerprinting vector.',
    points:         3,
    versionPattern: null,
  },
  {
    name:           'x-aspnetmvc-version',
    display:        'X-AspNetMvc-Version',
    description:    'Exposes ASP.NET MVC version — narrows attack surface identification.',
    points:         2,
    versionPattern: null,
  },
];

// ─── Auditor ──────────────────────────────────────────────────────────────────
/**
 * @param {object} responseHeaders - Raw headers object from Axios (keys already lowercase).
 * @returns {{ score, maxScore, metrics, overallStatus }}
 */
export function auditSecurityHeaders(responseHeaders) {
  // Normalise header keys to lowercase for cross-server consistency.
  const headers = Object.fromEntries(
    Object.entries(responseHeaders).map(([k, v]) => [k.toLowerCase(), v])
  );

  const maxScore = 35;
  let rawScore = 0;

  const securityHeaderMetrics = {};
  const infoLeakMetrics = {};

  // ── Required security headers ────────────────────────────────────────────
  for (const def of REQUIRED_HEADERS) {
    const value   = headers[def.name];
    const present = value !== undefined && value !== '';
    let status = present ? 'pass' : 'fail';

    // Some headers only confer protection with a specific value (e.g. X-Content-Type-Options).
    if (present && def.expectedValue) {
      const matches = String(value).toLowerCase().includes(def.expectedValue.toLowerCase());
      status = matches ? 'pass' : 'warning';
    }

    const points = status === 'pass' ? def.points : 0;
    rawScore += points;

    securityHeaderMetrics[def.name] = {
      displayName:    def.display,
      status,
      present,
      value:          value ?? null,
      description:    def.description,
      points,
      maxPoints:      def.points,
      recommendation: !present
        ? `Add the "${def.display}" response header to your web server / CDN configuration`
        : status === 'warning'
          ? `"${def.display}" is present but its value may not confer full protection. Expected: "${def.expectedValue}"`
          : null,
    };
  }

  // ── Information leak headers ─────────────────────────────────────────────
  for (const def of INFO_LEAK_HEADERS) {
    const value   = headers[def.name];
    const present = value !== undefined && value !== '';

    let leaking = false;
    let status  = 'pass';
    let note    = null;

    if (present) {
      if (def.versionPattern === null) {
        // Any presence of this header is a leak.
        leaking = true;
        status  = 'fail';
        note    = `Header exposes stack info: "${value}" — remove this header entirely`;
      } else if (def.versionPattern.test(String(value))) {
        // Version string detected.
        leaking = true;
        status  = 'fail';
        note    = `Version string exposed: "${value}" — strip the version component (e.g. use just "nginx")`;
      } else {
        // Header present but no version — tolerable but worth flagging.
        status = 'warning';
        note   = `Header present without version: "${value}" — consider removing it entirely for minimal information disclosure`;
      }
    }

    const points = leaking ? 0 : def.points;
    rawScore += points;

    infoLeakMetrics[def.name] = {
      displayName:    def.display,
      status,
      present,
      leaking,
      value:          value ?? null,
      description:    def.description,
      note,
      points,
      maxPoints:      def.points,
      recommendation: leaking
        ? `Remove or obfuscate "${def.display}" in your server/framework configuration`
        : null,
    };
  }

  const allMetrics = [...Object.values(securityHeaderMetrics), ...Object.values(infoLeakMetrics)];
  const overallStatus = allMetrics.every(m => m.status === 'pass')
    ? 'pass'
    : rawScore >= maxScore * 0.65
      ? 'warning'
      : 'fail';

  return {
    score:         Math.min(rawScore, maxScore),
    maxScore,
    metrics: {
      securityHeaders:  securityHeaderMetrics,
      informationLeaks: infoLeakMetrics,
    },
    overallStatus,
  };
}
