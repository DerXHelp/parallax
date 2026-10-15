import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import type * as ReactMarkdownModule from 'react-markdown';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetClientStore } from '@web/state/store';
import { SECURITY_MARKDOWN } from '../playground/data';
import { Markdown } from './Markdown';

/** Counts how often each block text is parsed (ReactMarkdown renders) – memoization check. */
const parsed = vi.hoisted(() => new Map<string, number>());
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactMarkdownModule>();
  const Original = actual.default;
  function CountingMarkdown(props: ComponentProps<typeof Original>) {
    const text = props.children ?? '';
    parsed.set(text, (parsed.get(text) ?? 0) + 1);
    return <Original {...props} />;
  }
  return { ...actual, default: CountingMarkdown };
});

// The renderer and Shiki are lazy chunks; load them once up front (the first import is slow in tests:
// ~20 s in a full `pnpm test`, over 60 s when several runs load the machine – docs/wp/FLAKES.md).
beforeAll(async () => {
  await import('./MarkdownRenderer');
  await import('../lib/highlight');
}, 180_000);

vi.setConfig({ testTimeout: 60_000 });

/** The first render still suspends once on the lazy renderer (React retries it asynchronously). */
const LAZY = { timeout: 15_000 };

afterEach(() => {
  parsed.clear();
  resetClientStore();
});

describe('Markdown', () => {
  it('renders GFM (lists, tables, task lists, inline code)', async () => {
    render(
      <Markdown text={'# Title\n\n- **bold** `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done'} />,
    );
    expect(await screen.findByRole('heading', { name: 'Title' }, LAZY)).toBeTruthy();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', true);
  });

  it('never renders raw HTML, scripts or images; only http(s) links are clickable', async () => {
    const { container } = render(<Markdown text={SECURITY_MARKDOWN} />);
    await screen.findByText('web link', {}, LAZY);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('[onclick], [onerror]')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toMatch(/^https:\/\/example\.com\//);
    for (const label of ['javascript link', 'data link', 'vbscript link', 'relative link']) {
      expect(screen.getByText(label).closest('a')).toBeNull();
      expect(screen.getByText(label).closest('[data-blocked-link]')).not.toBeNull();
    }
    expect(screen.getByText('foo@example.com').closest('a')).toBeNull();
    const web = screen.getByText('web link').closest('a');
    expect(web?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(web?.getAttribute('target')).toBe('_blank');
    expect(screen.getByText('Image: tracking pixel').closest('a')?.getAttribute('href')).toBe(
      'https://example.com/pixel.png',
    );
  });

  it('highlights closed code blocks only (Shiki, JS regex engine) and copies the code', async () => {
    const user = userEvent.setup();
    // After setup(): user-event installs its own clipboard stub.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <>
        <Markdown text={'```ts\nconst closed = 1;\n```'} />
        <Markdown streaming text={'```ts\nconst open = 1;'} />
      </>,
    );
    // Loads the TypeScript grammar on first use (another lazy import).
    await waitFor(
      () => {
        expect(document.querySelectorAll('[data-slot="code-block"][data-highlighted="true"]')).toHaveLength(
          1,
        );
      },
      { timeout: 30_000 },
    );
    const blocks = [...document.querySelectorAll('[data-slot="code-block"]')];
    expect(blocks[0]?.getAttribute('data-highlighted')).toBe('true');
    // Token colors are CSS variables (mapped to design tokens); exact token boundaries are Shiki's
    // business (under heavy test load its tokenize time limit may merge tokens).
    expect(blocks[0]?.querySelector('[style*="--shiki-token-keyword"]')?.textContent).toMatch(/^const/);
    expect(blocks[0]?.querySelector('code')?.textContent).toBe('const closed = 1;');
    expect(blocks[1]?.getAttribute('data-highlighted')).toBeNull();
    const copy = screen.getAllByRole('button', { name: 'Copy code' })[0];
    if (copy === undefined) throw new Error('no copy button');
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith('const closed = 1;');
  });

  it('parses only the last block again while streaming', async () => {
    const first = 'First paragraph.';
    const { rerender } = render(<Markdown streaming text={`${first}\n\nSecond`} />);
    await screen.findByText(first, {}, LAZY);
    rerender(<Markdown streaming text={`${first}\n\nSecond block grows`} />);
    rerender(<Markdown streaming text={`${first}\n\nSecond block grows more\n\nThird`} />);
    await screen.findByText('Second block grows more');
    expect(parsed.get(first)).toBe(1);
    expect(parsed.get('Second block grows more\n\nThird')).toBe(1);
  });
});
