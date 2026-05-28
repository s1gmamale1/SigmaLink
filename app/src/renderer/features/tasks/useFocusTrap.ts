// FE-4 a11y — minimal focus-trap for the hand-rolled Task drawers.
//
// The two Task drawers (NewTaskDrawer, TaskDetailDrawer) are NOT Radix
// dialogs — they are hand-rolled `<div role="dialog" aria-modal="true">`
// panels. They already manage return-focus + Escape themselves; this hook
// supplies the one missing WCAG 2.4.3 / 2.1.2 piece: containing Tab /
// Shift+Tab inside the panel so keyboard focus cannot escape the modal into
// the inert content behind it.
//
// Deliberately scoped — it does NOT touch return-focus or Escape (the drawers
// own those). Migrating to Radix would be a larger behavior change and is out
// of scope; this keeps the existing, tested dialog behavior intact.

import { useEffect, type RefObject } from 'react';

// Elements that can receive keyboard focus. Every clause carries
// `:not([tabindex="-1"])` so that any node explicitly removed from the Tab
// order — including a natively-focusable element like a <button> or <input>
// that has been given tabindex="-1" (e.g. the drawers' click-to-close backdrop
// scrim) — is excluded. The plain `[tabindex]:not([tabindex="-1"])` clause
// alone is NOT enough, because a `<button tabindex="-1">` still matches the
// bare `button` clause.
const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isHidden(el: HTMLElement): boolean {
  // `display:none` / `visibility:hidden` (or any inherited hide) → not a Tab
  // stop. We use getComputedStyle rather than offsetParent/getClientRects:
  // those rely on a layout engine (so they wrongly report EVERYTHING hidden in
  // jsdom, and wrongly exclude visible position:fixed elements in real
  // browsers). getComputedStyle is honored in both environments.
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return true;
  // `hidden` attribute (HTML) and inert ancestors also remove from Tab order.
  if (el.hidden) return true;
  return false;
}

function getFocusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => !isHidden(el));
}

/**
 * Trap Tab / Shift+Tab focus within `panelRef` while `active` is true.
 *
 * - Tab on the last focusable element wraps to the first.
 * - Shift+Tab on the first focusable element wraps to the last.
 * - If focus has somehow landed outside the panel (or nothing is focused) when
 *   Tab is pressed, focus is pulled back to the first focusable element.
 *
 * Does nothing about initial focus, return-focus, or Escape — callers own
 * those. Listener is attached to the panel (capture phase) so it sees Tab
 * before the browser's default focus move and can wrap deterministically.
 *
 * @param panelRef ref to the dialog panel element
 * @param active   whether the trap is engaged (typically the drawer's `open`)
 */
export function useFocusTrap(
  panelRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    if (!panel) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable(panel);
      if (focusable.length === 0) {
        // Nothing tabbable inside — keep focus on the panel itself rather than
        // letting it leak to the background.
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      const insidePanel = activeEl != null && panel.contains(activeEl);

      if (!insidePanel) {
        // Focus drifted outside the modal — reel it back in.
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    panel.addEventListener('keydown', onKeyDown, true);
    return () => panel.removeEventListener('keydown', onKeyDown, true);
  }, [panelRef, active]);
}
