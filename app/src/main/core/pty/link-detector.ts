// PTY URL detector — scans data chunks for OSC8 hyperlinks and bare URLs.
//
// Emits a `LinkHit` for each unique URL seen in a chunk. The detector is
// stateless across chunks for OSC8 (the OSC8 protocol terminates each link
// with a `\x1b]8;;\x1b\\` reset, so a single chunk almost always carries the
// full sequence in well-behaved emitters), and uses a simple regexp for plain
// URLs. We do NOT buffer partial sequences across chunks — at worst a link
// straddling a chunk boundary is missed; the user can always click the link
// in xterm-web-links once it has rendered.
//
// V3-W13-002. Runs on every PTY data chunk so it must stay cheap; the regex is
// a single non-recursive pass and the OSC8 scan is a manual loop with O(n).

export interface LinkHit {
  /** Full URL extracted from the chunk. */
  url: string;
  /** OSC8 visible label, when one was attached. */
  text?: string;
  /** Whether the hit came from an OSC8 sequence (true) or plain regex (false). */
  osc8: boolean;
}

// Standard OSC8 hyperlink:
//   ESC ] 8 ; <params> ; <url> ESC \  <text>  ESC ] 8 ; ; ESC \
// String terminators may also be BEL (\x07) on some emitters — accept both.
// `params` is rarely populated; we tolerate any chars except `;` so we can
// terminate the URL field.
const OSC8_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\]8;([^;]*);([^\x07\x1b]+)(?:\x07|\x1b\\)([^\x1b]*)\x1b\]8;;(?:\x07|\x1b\\)/g;

// Plain URL — http / https / file. Stop at whitespace or common terminator
// characters. Generous enough to catch typical CLI banners and `cd`-like
// suggestions; not greedy enough to swallow a trailing comma/period.
const PLAIN_URL_RE = /\b(?:https?|file):\/\/[^\s<>"'`)\]]+/g;

/**
 * Strip a trailing punctuation character (period, comma, paren, bracket,
 * angle bracket, semicolon, colon) so a URL printed at end of sentence still
 * resolves cleanly.
 */
function trimTrailingPunctuation(url: string): string {
  let out = url;
  while (out.length > 0 && /[.,;:!?\])>]/.test(out[out.length - 1] ?? '')) {
    out = out.slice(0, -1);
  }
  return out;
}

function looksLikeUrl(s: string): boolean {
  // Cheap sanity check: must have a scheme + a host-ish character. The
  // detector is best-effort; we'd rather under-fire than emit garbage.
  return /^(?:https?|file):\/\/.+/.test(s);
}

/**
 * Scan a single PTY data chunk for OSC8 hyperlinks and bare URLs.
 * Returns a deduplicated list of hits in first-seen order.
 */
export function detectLinks(chunk: string): LinkHit[] {
  if (!chunk) return [];
  const seen = new Set<string>();
  const hits: LinkHit[] = [];

  // 1) OSC8 hyperlinks first — preserve their `text` label.
  OSC8_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OSC8_RE.exec(chunk)) !== null) {
    const url = trimTrailingPunctuation(m[2] ?? '');
    if (!looksLikeUrl(url) || seen.has(url)) continue;
    seen.add(url);
    hits.push({ url, text: m[3], osc8: true });
  }

  // 2) Plain URLs — but skip any that already showed up inside an OSC8 hit
  //    (the regex above would re-hit the same URL bytes that were embedded
  //    in the OSC8 sequence).
  PLAIN_URL_RE.lastIndex = 0;
  while ((m = PLAIN_URL_RE.exec(chunk)) !== null) {
    const url = trimTrailingPunctuation(m[0]);
    if (!looksLikeUrl(url) || seen.has(url)) continue;
    seen.add(url);
    hits.push({ url, osc8: false });
  }

  return hits;
}
