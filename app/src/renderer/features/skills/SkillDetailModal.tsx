// Detail modal for a skill — renders SKILL.md (frontmatter + body) in a
// read-only preview. We intentionally don't pull in `react-markdown` for v1;
// instead we ship a minimal built-in renderer that handles the syntax we
// regularly see in Anthropic skill bodies (headings, lists, fenced code,
// inline code, bold/italic). The output is plain HTML escaped at the
// boundaries so untrusted markdown can't inject DOM.

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { rpc } from '@/renderer/lib/rpc';
import type { Skill } from '@/shared/types';

interface Props {
  skill: Skill | null;
  onClose: () => void;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Tiny Markdown renderer covering the subset that appears in SKILL.md bodies.
 * Not a full parser — known limitations: no tables, no nested lists, no
 * blockquotes, no images. The frontmatter is rendered as a code block.
 */
function renderMarkdown(src: string): string {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let inCodeFence = false;
  let codeLang = '';
  let codeBuffer: string[] = [];
  let inList = false;

  const flushList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  const inlineFormat = (raw: string): string => {
    // Order matters: code spans first so we don't format inside them.
    let text = escapeHtml(raw);
    text = text.replace(/`([^`]+?)`/g, (_m, c) => `<code class="rounded bg-muted/60 px-1 py-0.5 text-[0.85em]">${c}</code>`);
    text = text.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|\W)\*([^*]+?)\*(\W|$)/g, '$1<em>$2</em>$3');
    text = text.replace(/\[([^\]]+?)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" class="underline" target="_blank" rel="noreferrer">$1</a>');
    return text;
  };

  for (const line of lines) {
    if (inCodeFence) {
      if (line.trim().startsWith('```')) {
        out.push(
          `<pre class="my-2 overflow-x-auto rounded-md bg-muted/40 p-3 text-xs"><code data-lang="${escapeHtml(codeLang)}">${escapeHtml(codeBuffer.join('\n'))}</code></pre>`,
        );
        codeBuffer = [];
        codeLang = '';
        inCodeFence = false;
      } else {
        codeBuffer.push(line);
      }
      continue;
    }
    if (line.trim().startsWith('```')) {
      flushList();
      inCodeFence = true;
      codeLang = line.trim().slice(3).trim();
      continue;
    }

    if (line.trim() === '') {
      flushList();
      out.push('');
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const sizeClass =
        level === 1 ? 'text-lg font-semibold mt-3'
          : level === 2 ? 'text-base font-semibold mt-3'
          : 'text-sm font-semibold mt-2';
      out.push(`<h${level} class="${sizeClass}">${inlineFormat(headingMatch[2])}</h${level}>`);
      continue;
    }

    const ulMatch = /^[\s]*[-*]\s+(.*)$/.exec(line);
    if (ulMatch) {
      if (!inList) {
        out.push('<ul class="my-1 list-disc pl-6 text-sm">');
        inList = true;
      }
      out.push(`<li>${inlineFormat(ulMatch[1])}</li>`);
      continue;
    }

    flushList();
    out.push(`<p class="my-1 text-sm leading-relaxed">${inlineFormat(line)}</p>`);
  }
  if (inCodeFence) {
    out.push(
      `<pre class="my-2 overflow-x-auto rounded-md bg-muted/40 p-3 text-xs"><code data-lang="${escapeHtml(codeLang)}">${escapeHtml(codeBuffer.join('\n'))}</code></pre>`,
    );
  }
  flushList();
  return out.join('\n');
}

export function SkillDetailModal({ skill, onClose }: Props) {
  const [body, setBody] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!skill) {
      setBody('');
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const out = await rpc.skills.getReadme(skill.id);
        if (!alive) return;
        setBody(out?.body ?? '');
      } catch (err) {
        if (!alive) return;
        setBody(`Failed to load SKILL.md: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [skill]);

  if (!skill) return null;
  const html = renderMarkdown(body);

  return (
    <Dialog open={!!skill} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{skill.name}</DialogTitle>
          <DialogDescription>{skill.description}</DialogDescription>
        </DialogHeader>
        <div className="text-xs text-muted-foreground">
          <span className="font-mono">{skill.managedPath}</span>
        </div>
        {loading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div
            className="prose prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
