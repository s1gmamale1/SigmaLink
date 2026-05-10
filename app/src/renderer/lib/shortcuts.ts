// Tiny global keyboard helper. Parses `cmd/ctrl/shift/alt + key` strings and
// runs a handler on a matching window keydown. Used by the command palette
// (`mod+k`) and any other top-level shortcut that should trigger regardless
// of the focused element (modulo a "no while editing" check the caller can
// implement themselves).

export type ShortcutHandler = (e: KeyboardEvent) => void;

export interface ParsedShortcut {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export const PLATFORM_IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.platform);

export function parseShortcut(spec: string): ParsedShortcut {
  const tokens = spec
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  let key = '';
  let ctrl = false;
  let meta = false;
  let shift = false;
  let alt = false;
  for (const t of tokens) {
    if (t === 'mod') {
      if (PLATFORM_IS_MAC) meta = true;
      else ctrl = true;
    } else if (t === 'ctrl' || t === 'control') ctrl = true;
    else if (t === 'cmd' || t === 'meta' || t === 'super') meta = true;
    else if (t === 'shift') shift = true;
    else if (t === 'alt' || t === 'option') alt = true;
    else key = t;
  }
  return { key, ctrl, meta, shift, alt };
}

export function matches(e: KeyboardEvent, parsed: ParsedShortcut): boolean {
  if (e.key.toLowerCase() !== parsed.key) return false;
  if (parsed.ctrl !== e.ctrlKey) return false;
  if (parsed.meta !== e.metaKey) return false;
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;
  return true;
}

/**
 * Bind a single shortcut for the lifetime of the returned `unbind` function.
 * Caller can call `unbind()` from a React effect cleanup.
 */
export function bindShortcut(spec: string, handler: ShortcutHandler): () => void {
  const parsed = parseShortcut(spec);
  const onKey = (e: KeyboardEvent) => {
    if (matches(e, parsed)) handler(e);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

export const MOD_KEY_LABEL = PLATFORM_IS_MAC ? '⌘' : 'Ctrl';
