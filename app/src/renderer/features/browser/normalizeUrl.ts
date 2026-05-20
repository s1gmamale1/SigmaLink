/**
 * v1.5.1-A — Extracted from AddressBar.tsx.
 *
 * Normalises a raw address-bar string into a navigable URL:
 * - Empty → about:blank
 * - about:blank (case-insensitive) → about:blank (only safe about: URL)
 * - Other about:* → Google search fallback (avoids Chromium internal pages)
 * - chrome: / file: → pass through
 * - https?:// → pass through
 * - bare domain / localhost → prepend https://
 * - everything else → Google search fallback
 */
export function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return 'about:blank';
  if (/^about:/i.test(t)) {
    // Only the literal about:blank (case-insensitive) is allowed through;
    // anything else (about:about, about:newtab, bare about:, etc.) is treated
    // as a search query to avoid landing on Chromium's internal directory page.
    if (t.toLowerCase() === 'about:blank') return 'about:blank';
    return 'https://www.google.com/search?q=' + encodeURIComponent(t);
  }
  if (t.startsWith('chrome:') || t.startsWith('file:')) return t;
  if (/^https?:\/\//i.test(t)) return t;
  // Heuristic: looks like a domain or path → prepend https://
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(t) || t.startsWith('localhost')) {
    return 'https://' + t;
  }
  // Otherwise treat as a Google query.
  return 'https://www.google.com/search?q=' + encodeURIComponent(t);
}
