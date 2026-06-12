// DOM terminal presenter P2 — pure URL detection for FlowView link anchors.
// Plain-text detection only; OSC-8 explicit hyperlinks are NOT surfaced by
// xterm's public buffer API and stay a known gap (record in the spec).

export interface UrlRange {
  start: number;
  /** exclusive */
  end: number;
  url: string;
}

const URL_RE = /https?:\/\/[^\s"'<> ]+/g;
const TRAILING_PUNCT = /[)\]}>.,;:!?]+$/;

export function findUrls(text: string): UrlRange[] {
  const out: UrlRange[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0]!;
    // Trim trailing punctuation, but keep balanced closing parens:
    // "https://a.dev/x(y)z" keeps ")z"; "(https://a.dev/x)" drops the ")".
    const trimmed = url.replace(TRAILING_PUNCT, '');
    const opens = (trimmed.match(/\(/g) ?? []).length;
    let keep = trimmed;
    let rest = url.slice(trimmed.length);
    while (rest.startsWith(')') && (keep.match(/\)/g) ?? []).length < opens) {
      keep += ')';
      rest = rest.slice(1);
    }
    url = keep;
    if (url.length > 'https://'.length) {
      out.push({ start: m.index!, end: m.index! + url.length, url });
    }
  }
  return out;
}
