// @vitest-environment jsdom
//
// Stage-3 C2 — overlay close button focus-ring assertions.
//
// Asserts that:
//   1. Dialog close button uses the STANDARD focus-visible:ring-[3px] pattern
//   2. Dialog close button does NOT use the legacy ring-offset-2 pattern
//   3. Sheet close button uses the STANDARD focus-visible:ring-[3px] pattern
//   4. Sheet close button does NOT use the legacy ring-offset-2 pattern
//   5. Both carry opacity-70 / hover:opacity-100
//   6. Both carry hover:bg-foreground/[0.07] ghost-on-glass token
//   7. DialogFooter uses flex-col-reverse / sm:flex-row / sm:justify-end ordering
//
// Tests are class-string assertions — no DOM render needed, avoiding the
// need to mock Radix portals in a headless environment.

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Pull the raw class strings from the source rather than rendering in jsdom.
// This is a deliberate lightweight approach: Radix primitives require a full
// browser environment for interactive tests; here we only care that the
// correct Tailwind classes are present in the component definition.
// ---------------------------------------------------------------------------

// We read the compiled module exports to get the component function source.
// Because Vite/vitest transforms the TSX, the easiest reliable way is to
// inspect the stringified function body.

import * as DialogModule from './dialog';
import * as SheetModule from './sheet';

const dialogContentSrc = DialogModule.DialogContent.toString();
const sheetContentSrc = SheetModule.SheetContent.toString();
const dialogFooterSrc = DialogModule.DialogFooter.toString();

describe('Dialog close button — focus-ring', () => {
  it('carries focus-visible:ring-[3px]', () => {
    expect(dialogContentSrc).toContain('focus-visible:ring-[3px]');
  });

  it('does NOT carry legacy ring-offset-2', () => {
    // Ensure the old pattern is gone from the close button area.
    // The content class string should not include ring-offset-2.
    expect(dialogContentSrc).not.toContain('ring-offset-2');
  });

  it('carries focus-visible:ring-ring/50', () => {
    expect(dialogContentSrc).toContain('focus-visible:ring-ring/50');
  });

  it('carries focus-visible:border-ring', () => {
    expect(dialogContentSrc).toContain('focus-visible:border-ring');
  });

  it('carries opacity-70 and hover:opacity-100', () => {
    expect(dialogContentSrc).toContain('opacity-70');
    expect(dialogContentSrc).toContain('hover:opacity-100');
  });

  it('carries ghost-on-glass hover token', () => {
    expect(dialogContentSrc).toContain('hover:bg-foreground/[0.07]');
  });
});

describe('Sheet close button — focus-ring', () => {
  it('carries focus-visible:ring-[3px]', () => {
    expect(sheetContentSrc).toContain('focus-visible:ring-[3px]');
  });

  it('does NOT carry legacy ring-offset-2', () => {
    expect(sheetContentSrc).not.toContain('ring-offset-2');
  });

  it('carries focus-visible:ring-ring/50', () => {
    expect(sheetContentSrc).toContain('focus-visible:ring-ring/50');
  });

  it('carries focus-visible:border-ring', () => {
    expect(sheetContentSrc).toContain('focus-visible:border-ring');
  });

  it('carries opacity-70 and hover:opacity-100', () => {
    expect(sheetContentSrc).toContain('opacity-70');
    expect(sheetContentSrc).toContain('hover:opacity-100');
  });

  it('carries ghost-on-glass hover token', () => {
    expect(sheetContentSrc).toContain('hover:bg-foreground/[0.07]');
  });
});

describe('DialogFooter — cancel-left / confirm-right ordering', () => {
  it('uses flex-col-reverse for mobile stacking', () => {
    expect(dialogFooterSrc).toContain('flex-col-reverse');
  });

  it('uses sm:flex-row for desktop ordering', () => {
    expect(dialogFooterSrc).toContain('sm:flex-row');
  });

  it('uses sm:justify-end to push confirm right', () => {
    expect(dialogFooterSrc).toContain('sm:justify-end');
  });
});
