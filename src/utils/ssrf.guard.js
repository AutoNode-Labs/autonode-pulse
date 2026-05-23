/**
 * SSRF Guard — Server-Side Request Forgery mitigation layer.
 *
 * Architectural decision: we hook into Node's DNS lookup callback rather than
 * resolving the IP in application code and then passing it to Axios. This means
 * the validation fires for EVERY socket connection — including connections made
 * after HTTP redirects — which closes the common redirect-chain SSRF bypass.
 *
 * Threat model covered:
 *   • Direct request to internal IP (e.g. http://10.0.0.1/)
 *   • Hostname that resolves to internal IP (e.g. http://attacker.com/ → 10.0.0.1)
 *   • Redirect chain to internal IP (http://legit.com → Location: http://192.168.1.1/)
 *   • AWS/GCP metadata endpoint (169.254.169.254)
 *
 * Threat model NOT covered (requires socket-level interception or a DNS proxy):
 *   • DNS rebinding attacks (IP changes between lookup and connect)
 *   For DNS rebinding resistance, deploy at the network level (egress firewall rule
 *   blocking RFC-1918 ranges), which is the correct defense-in-depth layer.
 */

import dns from 'dns';

// Every IPv4 CIDR range that must never be reachable from this service.
// References: RFC 1918, RFC 3927, RFC 6598, RFC 5737, RFC 6890, RFC 3171.
const BLOCKED_IPV4_CIDRS = [
  { base: '0.0.0.0',       bits: 8  }, // Current network (RFC 791)
  { base: '10.0.0.0',      bits: 8  }, // Private class A (RFC 1918)
  { base: '100.64.0.0',    bits: 10 }, // Shared address space (RFC 6598)
  { base: '127.0.0.0',     bits: 8  }, // Loopback (RFC 990)
  { base: '169.254.0.0',   bits: 16 }, // Link-local / AWS+GCP metadata (RFC 3927)
  { base: '172.16.0.0',    bits: 12 }, // Private class B (RFC 1918)
  { base: '192.0.0.0',     bits: 24 }, // IETF Protocol Assignments (RFC 6890)
  { base: '192.0.2.0',     bits: 24 }, // TEST-NET-1 (RFC 5737)
  { base: '192.168.0.0',   bits: 16 }, // Private class C (RFC 1918)
  { base: '198.18.0.0',    bits: 15 }, // Network benchmarking (RFC 2544)
  { base: '198.51.100.0',  bits: 24 }, // TEST-NET-2 (RFC 5737)
  { base: '203.0.113.0',   bits: 24 }, // TEST-NET-3 (RFC 5737)
  { base: '224.0.0.0',     bits: 4  }, // Multicast (RFC 3171)
  { base: '240.0.0.0',     bits: 4  }, // Reserved for future use (RFC 1112)
  { base: '255.255.255.255', bits: 32 }, // Broadcast
];

function ipv4ToUint32(ip) {
  // Use unsigned right-shift (>>>) to guarantee a non-negative 32-bit integer.
  return ip.split('.').reduce((acc, octet) => (acc * 256 + parseInt(octet, 10)) >>> 0, 0);
}

function isPrivateIpv4(ip) {
  const ipInt = ipv4ToUint32(ip);
  return BLOCKED_IPV4_CIDRS.some(({ base, bits }) => {
    // Build the network mask as an unsigned 32-bit integer.
    // Special-case /32 because (0xFFFFFFFF << 0) in JS is negative due to signed ints.
    const mask = bits === 32 ? 0xFFFFFFFF : ((~0 << (32 - bits)) >>> 0);
    return (ipInt & mask) === (ipv4ToUint32(base) & mask);
  });
}

function isPrivateIpv6(ip) {
  const n = ip.toLowerCase().replace(/^\[|\]$/g, '');

  if (n === '::1') return true;       // Loopback
  if (n === '::')  return true;       // Unspecified

  // Link-local: fe80::/10 — covers fe80–febf
  if (/^fe[89ab][0-9a-f]:/i.test(n)) return true;

  // Unique-local: fc00::/7 — covers fc00 and fd00
  if (/^f[cd]/i.test(n)) return true;

  // IPv4-mapped: ::ffff:a.b.c.d → validate embedded IPv4
  const mappedMatch = n.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mappedMatch) return isPrivateIpv4(mappedMatch[1]);

  // IPv4-compatible (deprecated but still handled): ::a.b.c.d
  const compatMatch = n.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (compatMatch) return isPrivateIpv4(compatMatch[1]);

  return false;
}

/**
 * Returns true if the given IP address falls in a private or reserved range.
 * @param {string} address - The IP address string.
 * @param {number} family  - Address family: 4 for IPv4, 6 for IPv6.
 */
export function isPrivateIp(address, family) {
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true; // Unknown family → block by default (fail-closed)
}

/**
 * Drop-in replacement for the `lookup` option accepted by Node's http.Agent and
 * https.Agent constructors. Rejects the connection if the resolved IP is private.
 *
 * Signature matches dns.lookup's callback: (hostname, options, callback).
 * callback signature: (err, address, family).
 */
export function ssrfSafeLookup(hostname, options, callback) {
  // Node's http.Agent (Node ≥18) passes `{ hints: 1024, all: true }`.
  // When `all: true`, dns.lookup's callback receives (err, addresses[]) — an array
  // of { address, family } objects — and the caller expects the callback to be
  // invoked with that same array shape. If we change `all` to `false` the scalar
  // value we pass back causes Node internals to throw "Invalid IP address: undefined".
  // We must therefore honour the `all` flag and adapt our validation accordingly.

  const wantsAll = typeof options === 'object' && options !== null && options.all === true;

  if (wantsAll) {
    // Receive the full address list, validate every entry, then forward the
    // original array so Node can pick the address it wants.
    dns.lookup(hostname, options, (err, addresses) => {
      if (err) { callback(err); return; }

      for (const { address, family } of addresses) {
        if (isPrivateIp(address, family)) {
          const ssrfErr = new Error(
            `SSRF_BLOCKED: "${hostname}" resolved to ${address} which is a private/reserved address.`
          );
          ssrfErr.code = 'SSRF_BLOCKED';
          callback(ssrfErr);
          return;
        }
      }

      callback(null, addresses);
    });
  } else {
    // Scalar form: callback is (err, address, family).
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) { callback(err); return; }

      if (isPrivateIp(address, family)) {
        const ssrfErr = new Error(
          `SSRF_BLOCKED: "${hostname}" resolved to ${address} which is a private/reserved address.`
        );
        ssrfErr.code = 'SSRF_BLOCKED';
        callback(ssrfErr);
        return;
      }

      callback(null, address, family);
    });
  }
}
