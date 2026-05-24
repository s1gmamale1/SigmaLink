// C-13 — Element-aware dispatch prompt builder.
// Pure function: assembles a structured prompt from a captured DOM element
// so an existing pane can receive targeted design instructions via PTY.

const HTML_TRUNCATE_LIMIT = 2000;

export interface ElementDispatchInput {
  prompt: string;
  selector?: string;
  html?: string;
  pageUrl?: string;
}

/**
 * Assembles a multipart prompt string from a captured element context.
 *
 * @param input - The element dispatch input containing prompt and optional
 *   DOM context (selector, outerHTML, page URL).
 * @returns A formatted string ready to type into a PTY.
 * @throws {Error} If `prompt` is blank or missing.
 */
export function buildElementDispatchPrompt(input: ElementDispatchInput): string {
  const trimmedPrompt = (input.prompt ?? '').trim();
  if (!trimmedPrompt) {
    throw new Error('buildElementDispatchPrompt: prompt must be a non-empty string');
  }

  const parts: string[] = [trimmedPrompt];

  if (input.selector && input.selector.trim()) {
    parts.push(`Selector: ${input.selector.trim()}`);
  }

  if (input.pageUrl && input.pageUrl.trim()) {
    parts.push(`Page URL: ${input.pageUrl.trim()}`);
  }

  if (input.html && input.html.trim()) {
    let html = input.html;
    let truncated = false;
    if (html.length > HTML_TRUNCATE_LIMIT) {
      html = html.slice(0, HTML_TRUNCATE_LIMIT);
      truncated = true;
    }
    const fencedBlock = '```html\n' + html + (truncated ? '…[truncated]' : '') + '\n```';
    parts.push(fencedBlock);
  }

  return parts.join('\n\n');
}
