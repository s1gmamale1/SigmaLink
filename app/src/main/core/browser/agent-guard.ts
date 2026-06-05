// BSP-B3 — SSRF guard for agent-driven browser navigation.
//
// Restricts URLs that Jorvis's in-process browser tools may navigate to.
// Default-OFF: every tool MUST check the KV gate `browser.agentDriving`
// before calling `assertAgentNavigable`.
//
// Security properties (enforced, tested):
//   • Only `https:` scheme allowed — no http:/file:/javascript:/data:.
//   • Loopback/private/non-unicast hosts are rejected. Uses `ipaddr.js` for
//     canonical IP classification — this handles:
//       - Alternate IPv4 encodings: decimal `2130706433`, hex `0x7f000001`,
//         octal/leading-zero forms (WHATWG URL parser normalises these BEFORE
//         we check the hostname, so `new URL('https://2130706433').hostname`
//         → `'127.0.0.1'`).
//       - IPv4-mapped IPv6: `::ffff:127.0.0.1`, `::ffff:10.0.0.1`.
//       - IPv6 loopback (`::1`, `0:0:0:0:0:0:0:1`), unspecified (`::`),
//         unique-local (`fc00::/7`), link-local (`fe80::/10`).
//       - IPv4 ranges: loopback (127), private (10/172.16-31/192.168),
//         link-local (169.254), CGNAT (100.64/10), unspecified (0.x).
//       - Cloud-metadata endpoint `169.254.169.254`.
//       - mDNS: `*.local`.
//       - `localhost`.
//
// Residual risk: DNS rebinding — a host that resolves to a public IP at
// guard time could change to a private IP after navigation. We do NOT do live
// DNS resolution here (Electron's main process can't block on async DNS during
// a tool call). The guard catches all literal private-IP hostnames. For
// production hardening, wire Electron's `webRequest.onBeforeRequest` to block
// any resolved-to-private requests at the network layer.
//
// Prompt-injection residual: page content returned by `browser_snapshot` is
// untrusted text that could contain crafted instructions to the model. The
// `scanIngested` gate (aidefence) is applied on the snapshot output, but
// sophisticated injections may survive redaction. The operator should treat
// agent-browser output as untrusted and review unexpected model actions.

import * as ipaddr from 'ipaddr.js';

export class AgentNavigationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AgentNavigationError';
  }
}

/**
 * Returns true if the host (already normalised by the WHATWG URL parser) is
 * non-routable for agent use. We use `ipaddr.js` for canonical range
 * classification — it handles alternate encodings, IPv4-mapped IPv6, and all
 * known private ranges including CGNAT and cloud-metadata (169.254.169.254).
 */
function hostIsBlocked(hostname: string): boolean {
  // mDNS / loopback hostnames.
  const lower = hostname.toLowerCase();
  if (lower === 'localhost') return true;
  if (lower.endsWith('.local')) return true;

  // Strip IPv6 brackets added by the URL parser.
  const stripped = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;

  if (!ipaddr.isValid(stripped)) {
    // Not an IP literal. Belt-and-suspenders: reject bare numeric forms that
    // the URL parser might not have normalized (e.g. pure integers, hex).
    if (/^\d+$/u.test(stripped) || /^0x/iu.test(stripped)) return true;
    return false;
  }

  let addr: ipaddr.IPv4 | ipaddr.IPv6 = ipaddr.parse(stripped);

  // Unwrap IPv4-mapped IPv6 (::ffff:x.x.x.x) so range() classifies it as IPv4.
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    }
  }

  // `range()` returns one of: unicast, loopback, private, linkLocal,
  // uniqueLocal, unspecified, reserved, broadcast, carrierGradeNat,
  // multicast, 6to4, teredo, benchmarking, documentation, …
  // We ALLOW only `unicast`; every other range is non-routable.
  const range = addr.range();
  return range !== 'unicast';
}

/**
 * Throws `AgentNavigationError` if the URL is not safe for agent navigation.
 *
 * Allowed: `https://` URLs pointing at public, non-private hosts.
 * Rejected: any other scheme; private/loopback/non-unicast hosts; malformed URLs.
 */
export function assertAgentNavigable(url: string): void {
  if (!url) throw new AgentNavigationError('invalid url: (empty)');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AgentNavigationError(`invalid url: ${url}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new AgentNavigationError(
      `unsupported scheme "${parsed.protocol}" — only https: is allowed`,
    );
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new AgentNavigationError('url has no host');
  }

  if (hostIsBlocked(hostname)) {
    throw new AgentNavigationError(
      `private/loopback host "${hostname}" is not accessible to the agent browser`,
    );
  }
}
