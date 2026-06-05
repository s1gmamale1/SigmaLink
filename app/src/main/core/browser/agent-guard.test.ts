// BSP-B3 — SSRF guard unit tests.
// TDD: this table was written BEFORE the implementation to drive the shape.
//
// The table covers all bypass vectors identified in the security review:
//   - Alternate IPv4 encodings (decimal, hex — WHATWG URL parser normalises them)
//   - IPv4-mapped IPv6 (::ffff:x)
//   - Cloud-metadata endpoint (169.254.169.254)
//   - CGNAT (100.64.0.0/10)
//   - IPv6 full-form loopback (0:0:0:0:0:0:0:1), unspecified (::)
//   - All RFC 1918 private ranges
//   - localhost + *.local
//   - Scheme violations (http, file, javascript, data)

import { describe, expect, it } from 'vitest';
import { assertAgentNavigable, AgentNavigationError } from './agent-guard';

const ALLOWED: Array<[string, string]> = [
  ['https://example.com', 'plain https public domain'],
  ['https://www.google.com/search?q=test', 'https with path and query'],
  ['https://api.github.com/repos', 'https API subdomain'],
  ['https://1.1.1.1', 'public IPv4 Cloudflare DNS'],
  ['https://8.8.8.8', 'public IPv4 Google DNS'],
  ['https://1.2.3.4', 'another public IPv4'],
  ['https://[2606:4700::1111]', 'public IPv6 Cloudflare'],
  // NOTE: 2001:db8::/32 and 198.51.100.0/24 are documentation/TEST-NET ranges
  // classified as "reserved" by ipaddr.js — correctly blocked, not added here.
];

const BLOCKED: Array<[string, string]> = [
  // Scheme violations
  ['http://example.com', 'http scheme'],
  ['file:///etc/passwd', 'file scheme'],
  ['javascript:alert(1)', 'javascript scheme'],
  ['data:text/html,<h1>hi</h1>', 'data scheme'],
  ['ftp://example.com', 'ftp scheme'],

  // Loopback / local names
  ['https://localhost', 'localhost'],
  ['https://localhost:8080/api', 'localhost with port'],
  ['https://foo.local', '*.local mDNS'],
  ['https://bar.local/endpoint', '*.local with path'],

  // IPv4 loopback — standard dotted notation
  ['https://127.0.0.1', '127.0.0.1 loopback'],
  ['https://127.1.2.3', '127.x.x.x loopback'],

  // IPv4 loopback — alternate encodings (WHATWG URL parser normalises these)
  ['https://2130706433', 'decimal loopback (127.0.0.1)'],
  ['https://0x7f000001', 'hex loopback (0x7f000001 = 127.0.0.1)'],

  // IPv4 unspecified
  ['https://0.0.0.0', '0.0.0.0 unspecified'],
  ['https://0.1.2.3', '0.x.x.x unspecified'],

  // RFC 1918 class A
  ['https://10.0.0.1', '10.x private A'],
  ['https://10.255.255.255', '10.255 private A'],

  // RFC 1918 class B
  ['https://172.16.0.1', '172.16 private B'],
  ['https://172.20.5.10', '172.20 private B'],
  ['https://172.31.255.255', '172.31 private B'],

  // RFC 1918 class C
  ['https://192.168.0.1', '192.168 private C'],
  ['https://192.168.100.200', '192.168 private C variant'],

  // Link-local (including cloud-metadata endpoint — critical SSRF target)
  ['https://169.254.0.1', '169.254 link-local'],
  ['https://169.254.169.254', 'AWS IMDS / GCP metadata (critical SSRF)'],

  // CGNAT (RFC 6598 — 100.64.0.0/10)
  ['https://100.64.0.1', 'CGNAT 100.64.0.0/10'],
  ['https://100.127.255.255', 'CGNAT upper bound'],

  // IPv6 loopback forms
  ['https://[::1]', 'IPv6 loopback ::1'],
  ['https://[::1]:8080/api', 'IPv6 loopback with port'],
  ['https://[0:0:0:0:0:0:0:1]', 'IPv6 loopback full-form'],

  // IPv6 unspecified
  ['https://[::]', 'IPv6 unspecified ::'],

  // IPv4-mapped IPv6
  ['https://[::ffff:127.0.0.1]', 'IPv4-mapped IPv6 loopback'],
  ['https://[::ffff:10.0.0.1]', 'IPv4-mapped IPv6 private A'],
  ['https://[::ffff:192.168.1.1]', 'IPv4-mapped IPv6 private C'],

  // IPv6 unique-local (fc00::/7)
  ['https://[fc00::1]', 'IPv6 unique-local fc00'],
  ['https://[fd12:3456:789a::1]', 'IPv6 unique-local fd prefix'],

  // IPv6 link-local
  ['https://[fe80::1]', 'IPv6 link-local fe80'],

  // Malformed
  ['not-a-url', 'not a URL at all'],
  ['', 'empty string'],
  ['https://', 'https with no host'],
];

describe('assertAgentNavigable — ALLOWED', () => {
  for (const [url, label] of ALLOWED) {
    it(`allows ${label} (${url})`, () => {
      expect(() => assertAgentNavigable(url)).not.toThrow();
    });
  }
});

describe('assertAgentNavigable — BLOCKED', () => {
  for (const [url, label] of BLOCKED) {
    it(`blocks ${label} (${url})`, () => {
      expect(() => assertAgentNavigable(url)).toThrowError(AgentNavigationError);
    });
  }
});
