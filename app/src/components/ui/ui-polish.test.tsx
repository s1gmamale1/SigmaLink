// @vitest-environment jsdom
//
// Stage-3 UI polish — tabs, badge, and card class assertions.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

afterEach(() => cleanup());

// ---- Tabs -------------------------------------------------------------------

import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';

describe('TabsTrigger — Stage-3 segmented control polish', () => {
  function renderTabs(defaultValue = 'a') {
    return render(
      <Tabs defaultValue={defaultValue}>
        <TabsList>
          <TabsTrigger value="a">Alpha</TabsTrigger>
          <TabsTrigger value="b">Beta</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
        <TabsContent value="b">Panel B</TabsContent>
      </Tabs>,
    );
  }

  it('active trigger carries data-[state=active]:bg-background token', () => {
    const { getAllByRole } = renderTabs('a');
    const [trigger] = getAllByRole('tab');
    expect(trigger.className).toContain('data-[state=active]:bg-background');
  });

  it('active trigger carries data-[state=active]:shadow-sm token', () => {
    const { getAllByRole } = renderTabs('a');
    const [trigger] = getAllByRole('tab');
    expect(trigger.className).toContain('data-[state=active]:shadow-sm');
  });

  it('trigger carries text-muted-foreground (inactive base)', () => {
    const { getAllByRole } = renderTabs('a');
    const [trigger] = getAllByRole('tab');
    expect(trigger.className).toContain('text-muted-foreground');
  });

  it('trigger carries data-[state=active]:text-foreground override', () => {
    const { getAllByRole } = renderTabs('a');
    const [trigger] = getAllByRole('tab');
    expect(trigger.className).toContain('data-[state=active]:text-foreground');
  });

  it('trigger has standard focus-ring tokens (ring-[3px])', () => {
    const { getAllByRole } = renderTabs('a');
    const [trigger] = getAllByRole('tab');
    expect(trigger.className).toContain('focus-visible:ring-[3px]');
    expect(trigger.className).toContain('focus-visible:ring-ring/50');
    expect(trigger.className).toContain('focus-visible:border-ring');
  });

  it('trigger does NOT have the legacy outline-1 override', () => {
    const { getAllByRole } = renderTabs('a');
    const [trigger] = getAllByRole('tab');
    expect(trigger.className).not.toContain('focus-visible:outline-1');
  });

  it('trigger carries transition-[color,box-shadow] for motion spec', () => {
    const { getAllByRole } = renderTabs('a');
    const [trigger] = getAllByRole('tab');
    expect(trigger.className).toContain('transition-[color,box-shadow]');
  });
});

// ---- Badge ------------------------------------------------------------------

import { Badge } from './badge';

describe('Badge — variant class snapshot & focus-ring standard', () => {
  it('default variant has correct class tokens', () => {
    const { container } = render(<Badge>Label</Badge>);
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement;
    expect(el.className).toContain('rounded-full');
    expect(el.className).toContain('bg-primary');
    expect(el.className).toContain('text-primary-foreground');
  });

  it('secondary variant renders expected classes', () => {
    const { container } = render(<Badge variant="secondary">Label</Badge>);
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement;
    expect(el.className).toContain('bg-secondary');
    expect(el.className).toContain('text-secondary-foreground');
  });

  it('destructive variant renders expected classes', () => {
    const { container } = render(<Badge variant="destructive">Label</Badge>);
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement;
    expect(el.className).toContain('bg-destructive');
  });

  it('outline variant renders expected classes', () => {
    const { container } = render(<Badge variant="outline">Label</Badge>);
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement;
    expect(el.className).toContain('text-foreground');
  });

  it('badge base carries standard focus-ring tokens', () => {
    const { container } = render(<Badge>Label</Badge>);
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement;
    expect(el.className).toContain('focus-visible:ring-[3px]');
    expect(el.className).toContain('focus-visible:ring-ring/50');
    expect(el.className).toContain('focus-visible:border-ring');
  });

  it('badge base carries transition-[color,box-shadow] motion spec', () => {
    const { container } = render(<Badge>Label</Badge>);
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement;
    expect(el.className).toContain('transition-[color,box-shadow]');
  });
});

// ---- Card -------------------------------------------------------------------

import { Card, CardHeader, CardTitle, CardContent } from './card';

describe('Card — apple-grade surface tokens', () => {
  it('carries bg-card, rounded-xl, border, shadow-sm', () => {
    const { container } = render(
      <Card>
        <CardHeader><CardTitle>T</CardTitle></CardHeader>
        <CardContent>body</CardContent>
      </Card>,
    );
    const card = container.querySelector('[data-slot="card"]') as HTMLElement;
    expect(card.className).toContain('bg-card');
    expect(card.className).toContain('rounded-xl');
    expect(card.className).toContain('border');
    expect(card.className).toContain('shadow-sm');
  });

  it('carries transition-[color,box-shadow] for theme-switch smoothness', () => {
    const { container } = render(<Card>content</Card>);
    const card = container.querySelector('[data-slot="card"]') as HTMLElement;
    expect(card.className).toContain('transition-[color,box-shadow]');
  });
});
