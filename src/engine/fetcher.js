/**
 * SSRF-safe HTTP fetcher.
 *
 * The core defense: we pass `ssrfSafeLookup` as the `lookup` option to both
 * the HTTP and HTTPS agents. Node's net.Socket uses this function for every
 * DNS resolution it performs — meaning the check fires:
 *   1. On the initial request.
 *   2. On every connection after an HTTP redirect.
 *
 * This means an attacker cannot bypass the check by returning a safe IP on the
 * first DNS query and then redirecting to an internal endpoint. The guard runs
 * again on the redirect target's hostname.
 *
 * Trade-off: we are still susceptible to DNS rebinding between the lookup() call
 * and the actual TCP SYN packet. For production deployments, pair this with an
 * egress firewall rule (iptables/nftables) that denies RFC-1918 traffic from the
 * application process — that is the correct network-layer defense-in-depth.
 */

import axios from 'axios';
import { Agent as HttpAgent }  from 'http';
import { Agent as HttpsAgent } from 'https';
import { ssrfSafeLookup } from '../utils/ssrf.guard.js';

const FETCH_TIMEOUT_MS        = 15_000;   // 15 s — balances responsiveness with slow sites
const MAX_RESPONSE_BYTES      = 5 * 1024 * 1024; // 5 MB — prevents memory exhaustion on huge pages
const MAX_REDIRECTS           = 5;        // RFC 7231 recommendation

// A descriptive bot UA so audited sites can identify (and optionally allow) us.
const USER_AGENT = 'AutoNodePulse/1.0 Audit-Bot (+https://github.com/autonode-pulse)';

// Agents are created once and reused across requests (connection pooling).
// The lookup hook fires on every new TCP connection, not just once per agent.
const safeHttpAgent  = new HttpAgent ({ lookup: ssrfSafeLookup });
const safeHttpsAgent = new HttpsAgent({ lookup: ssrfSafeLookup });

/**
 * Fetches a URL with SSRF protection, timeout, and size capping.
 *
 * @param {string} url
 * @param {object} [opts]          - Optional Axios overrides (e.g. extra headers).
 * @returns {{ data, headers, status, finalUrl }}
 */
export async function fetchUrl(url, opts = {}) {
  try {
    const response = await axios.get(url, {
      httpAgent:  safeHttpAgent,
      httpsAgent: safeHttpsAgent,
      timeout:    FETCH_TIMEOUT_MS,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxRedirects: MAX_REDIRECTS,
      // Do NOT throw on 4xx/5xx — we want to audit the response regardless of status.
      validateStatus: (status) => status < 600,
      decompress: true,
      headers: {
        'User-Agent':      USER_AGENT,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        ...(opts.headers ?? {}),
      },
      ...opts,
    });

    return {
      data:     response.data,
      headers:  response.headers,   // Raw Axios headers (lowercase keys)
      status:   response.status,
      finalUrl: response.request?.res?.responseUrl ?? url, // URL after redirects
    };
  } catch (err) {
    // Re-throw with normalized error codes so the controller can map to HTTP status.
    if (err.code === 'SSRF_BLOCKED') {
      const e = new Error(err.message);
      e.code = 'SSRF_BLOCKED';
      throw e;
    }
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      const e = new Error(`Request to "${url}" timed out after ${FETCH_TIMEOUT_MS}ms`);
      e.code = 'FETCH_TIMEOUT';
      throw e;
    }
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_NONAME') {
      const e = new Error(`DNS resolution failed for "${url}"`);
      e.code = 'DNS_ERROR';
      throw e;
    }
    if (err.code === 'ECONNREFUSED') {
      const e = new Error(`Connection refused by "${url}"`);
      e.code = 'CONN_REFUSED';
      throw e;
    }
    throw err;
  }
}

/**
 * Fetches /robots.txt for a given base URL.
 * Returns a result object rather than throwing — robots.txt absence is a
 * soft audit finding, not a hard failure.
 *
 * @param {string} baseUrl  - The origin to audit (e.g. "https://example.com").
 * @returns {{ accessible: boolean, content: string|null, status: number|null, error: string|null }}
 */
export async function fetchRobotsTxt(baseUrl) {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).toString();
    const result = await fetchUrl(robotsUrl, {
      headers: { 'Accept': 'text/plain, text/*, */*;q=0.8' },
    });

    const accessible = result.status >= 200 && result.status < 400;
    return {
      accessible,
      content:  accessible ? String(result.data) : null,
      status:   result.status,
      error:    null,
    };
  } catch (err) {
    return {
      accessible: false,
      content:    null,
      status:     null,
      error:      err.message,
    };
  }
}
