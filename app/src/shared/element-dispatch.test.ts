import { describe, it, expect } from 'vitest';
import { buildElementDispatchPrompt } from './element-dispatch';

describe('buildElementDispatchPrompt', () => {
  it('composes', () => {
    const o = buildElementDispatchPrompt({
      prompt: 'make it blue',
      selector: '.btn',
      html: '<button>Go</button>',
      pageUrl: 'http://localhost:3000/',
    });
    expect(o).toContain('make it blue');
    expect(o).toContain('.btn');
    expect(o).toContain('http://localhost:3000/');
    expect(o).toContain('<button>Go</button>');
  });

  it('truncates + throws', () => {
    expect(buildElementDispatchPrompt({ prompt: 'x', html: 'a'.repeat(5000) }).length).toBeLessThan(2300);
    expect(() => buildElementDispatchPrompt({ prompt: '  ' })).toThrow();
  });

  it('includes Selector: line', () => {
    const o = buildElementDispatchPrompt({ prompt: 'style it', selector: '#header' });
    expect(o).toContain('Selector: #header');
  });

  it('includes Page URL line', () => {
    const o = buildElementDispatchPrompt({ prompt: 'fix layout', pageUrl: 'https://example.com/page' });
    expect(o).toContain('Page URL: https://example.com/page');
  });

  it('omits empty selector and html', () => {
    const o = buildElementDispatchPrompt({ prompt: 'change color', selector: '', html: '' });
    expect(o).not.toContain('Selector:');
    expect(o).not.toContain('```html');
  });

  it('throws for missing prompt', () => {
    expect(() => buildElementDispatchPrompt({ prompt: '' })).toThrow();
  });

  it('wraps html in fenced code block', () => {
    const o = buildElementDispatchPrompt({ prompt: 'fix', html: '<div>hello</div>' });
    expect(o).toContain('```html');
    expect(o).toContain('<div>hello</div>');
    expect(o).toContain('```');
  });

  it('appends truncation marker when html is too long', () => {
    const o = buildElementDispatchPrompt({ prompt: 'fix', html: 'b'.repeat(3000) });
    expect(o).toContain('…[truncated]');
  });
});
