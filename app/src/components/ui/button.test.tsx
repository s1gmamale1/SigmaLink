// @vitest-environment jsdom
//
// Stage-3 apple-grade controls (Lane C1) — asserts the shared control
// vocabulary baked into `buttonVariants`:
//   - new `tinted` tier  → bg-primary/15 + text-primary (+ hover bg-primary/25)
//   - ghost-on-glass      → hover:bg-foreground/[0.07] (theme-adaptive tint,
//                            no glass-on-glass, replaces the old accent hover)
//   - press + motion      → active:scale-[0.98] (motion-reduce safe) on the base
//   - focus-ring standard  → border-ring + ring-ring/50 + ring-[3px] (untouched)
// These are pure class-string assertions over the cva output — no render needed.

import { describe, expect, it } from 'vitest';

import { buttonVariants } from './button.data';

describe('buttonVariants — tinted tier', () => {
  it('exposes a tinted variant tinted with the primary color', () => {
    const cls = buttonVariants({ variant: 'tinted' });
    expect(cls).toContain('bg-primary/15');
    expect(cls).toContain('text-primary');
  });

  it('tinted deepens its tint on hover', () => {
    const cls = buttonVariants({ variant: 'tinted' });
    expect(cls).toContain('hover:bg-primary/25');
  });
});

describe('buttonVariants — ghost-on-glass hover', () => {
  it('ghost uses a subtle theme-adaptive foreground tint', () => {
    const cls = buttonVariants({ variant: 'ghost' });
    expect(cls).toContain('hover:bg-foreground/[0.07]');
  });

  it('ghost no longer uses the opaque accent hover (glass-on-glass)', () => {
    const cls = buttonVariants({ variant: 'ghost' });
    expect(cls).not.toContain('hover:bg-accent');
  });
});

describe('buttonVariants — press + motion', () => {
  it('base presses inward on active, with a motion-reduce escape hatch', () => {
    const cls = buttonVariants();
    expect(cls).toContain('active:scale-[0.98]');
    expect(cls).toContain('motion-reduce:active:scale-100');
  });

  it('base transitions an explicit property list (not transition-all)', () => {
    const cls = buttonVariants();
    expect(cls).toContain('transition-[color,box-shadow,transform]');
    expect(cls).not.toContain('transition-all');
  });
});

describe('buttonVariants — focus-ring standard preserved', () => {
  it('keeps the shared focus-visible ring vocabulary', () => {
    const cls = buttonVariants();
    expect(cls).toContain('focus-visible:border-ring');
    expect(cls).toContain('focus-visible:ring-ring/50');
    expect(cls).toContain('focus-visible:ring-[3px]');
  });

  it('still carries the untouched default / destructive tiers', () => {
    expect(buttonVariants({ variant: 'default' })).toContain('bg-primary');
    expect(buttonVariants({ variant: 'destructive' })).toContain('bg-destructive');
  });
});
