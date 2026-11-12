import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement } from 'react';
import type * as ReactMarkdownModule from 'react-markdown';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { SAMPLE_IDS, sampleSummary } from '@shared/samples';
import { FeatureSlotsProvider, type FeatureSlots, type FileLinkSlotProps } from '@web/shell/slots';
import { clientStore, resetClientStore, updateHost } from '@web/state/store';
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
  await import('@web/lib/highlight');
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

  it('V2-12: keeps the backslashes of Windows paths in running text, escapes elsewhere stay escapes', async () => {
    const { container } = render(
      <Markdown
        text={[
          'Implement the plan in C:\\Users\\user\\.claude\\plans\\x.md now.',
          '',
          'Build into D:\\work\\_out\\ and \\*not bold\\* or snake\\_case.',
          '',
          'Code `C:\\Users\\.claude` stays.',
        ].join('\n')}
      />,
    );
    await screen.findByText(/Implement the plan/, {}, LAZY);
    const paragraphs = [...container.querySelectorAll('p')].map((p) => p.textContent);
    expect(paragraphs).toEqual([
      'Implement the plan in C:\\Users\\user\\.claude\\plans\\x.md now.',
      'Build into D:\\work\\_out\\ and *not bold* or snake_case.',
      'Code C:\\Users\\.claude stays.',
    ]);
    expect(container.querySelector('strong, em')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('C:\\Users\\.claude');
  });

  describe('file references (WP-55)', () => {
    const entryId = SAMPLE_IDS.entry;
    const sessionKey = makeSessionKey(LOCAL_HOST_ID, entryId);

    /** FileLink stand-in: shows the props it got. */
    function ProbeFileLink({ path, line, col, verify, children }: FileLinkSlotProps) {
      return (
        <span
          data-testid="file-link"
          data-path={path}
          data-line={line ?? ''}
          data-col={col ?? ''}
          data-verify={String(verify)}
        >
          {children ?? path}
        </span>
      );
    }
    const PROBE_SLOTS: Partial<FeatureSlots> = { FileLink: ProbeFileLink };

    function renderWithSlots(element: ReactElement) {
      return render(<FeatureSlotsProvider slots={PROBE_SLOTS}>{element}</FeatureSlotsProvider>);
    }

    function links(): { text: string | null; path: string | undefined; line: string | undefined }[] {
      return screen.queryAllByTestId('file-link').map((link) => ({
        text: link.textContent,
        path: link.dataset.path,
        line: link.dataset.line,
      }));
    }

    beforeEach(() => {
      updateHost(clientStore, LOCAL_HOST_ID, () => ({
        summaries: { [entryId]: sampleSummary({ entryId }) },
      }));
    });

    it('links paths in text and inline code (verify, relative to the cwd), never in code blocks', async () => {
      renderWithSlots(
        <Markdown
          sessionKey={sessionKey}
          text={[
            'Changed src/main.ts:26 and C:\\Users\\user\\.claude\\plans\\x.md, see (README.md).',
            '',
            'Run `pnpm exec vitest run src/web/lib/file-refs.test.ts` or `D:/work/sample/docs/a.md#L4`.',
            '',
            '```',
            'src/in/code.ts',
            '```',
          ].join('\n')}
        />,
      );
      await screen.findByText(/Changed/, {}, LAZY);
      expect(links()).toEqual([
        { text: 'src/main.ts:26', path: 'D:\\work\\sample\\src\\main.ts', line: '26' },
        {
          text: 'C:\\Users\\user\\.claude\\plans\\x.md',
          path: 'C:\\Users\\user\\.claude\\plans\\x.md',
          line: '',
        },
        {
          text: 'src/web/lib/file-refs.test.ts',
          path: 'D:\\work\\sample\\src\\web\\lib\\file-refs.test.ts',
          line: '',
        },
        { text: 'D:/work/sample/docs/a.md#L4', path: 'D:\\work\\sample\\docs\\a.md', line: '4' },
      ]);
      for (const link of screen.getAllByTestId('file-link')) expect(link.dataset.verify).toBe('true');
      // Inline code keeps its code element around the link; the code block stays plain code.
      expect(screen.getByText('src/web/lib/file-refs.test.ts').closest('code')).not.toBeNull();
      expect(screen.getByText('src/in/code.ts').closest('[data-testid="file-link"]')).toBeNull();
    });

    it('links absolute paths with spaces whole – in text up to the file, in inline code as one span (V4-01)', async () => {
      const project = 'C:\\Users\\Max Mustermann\\proj\\Projekt mit Leerzeichen äöü';
      const { container } = renderWithSlots(
        <Markdown
          sessionKey={sessionKey}
          text={[
            `Changed ${project}\\README.md:3 and C:\\Users\\Max Mustermann\\.claude\\x.md.`,
            '',
            `Code: \`${project}\` and \`C:\\Users\\Max\\My File.txt\`.`,
            '',
            `The folder ${project} stays text, so does C:\\Users\\Max\\My File.txt; C:\\a\\b.ts and c.md.`,
          ].join('\n')}
        />,
      );
      await screen.findByText(/Changed/, {}, LAZY);
      expect(links()).toEqual([
        { text: `${project}\\README.md:3`, path: `${project}\\README.md`, line: '3' },
        // The backslash before `.claude` survives the Markdown parser (preserveWindowsPaths).
        {
          text: 'C:\\Users\\Max Mustermann\\.claude\\x.md',
          path: 'C:\\Users\\Max Mustermann\\.claude\\x.md',
          line: '',
        },
        { text: project, path: project, line: '' },
        { text: 'C:\\Users\\Max\\My File.txt', path: 'C:\\Users\\Max\\My File.txt', line: '' },
        { text: 'C:\\a\\b.ts', path: 'C:\\a\\b.ts', line: '' },
      ]);
      // No prefix of a name with spaces reaches FileLink (it would be checked and maybe refused).
      const paragraphs = [...container.querySelectorAll('p')].map((p) => p.textContent);
      expect(paragraphs[2]).toBe(
        `The folder ${project} stays text, so does C:\\Users\\Max\\My File.txt; C:\\a\\b.ts and c.md.`,
      );
    });

    it('UNC and device paths stay text and never reach FileLink (also as link targets)', async () => {
      const { container } = renderWithSlots(
        <Markdown
          sessionKey={sessionKey}
          text={[
            'Share \\\\server\\share\\x.txt and \\\\?\\C:\\x\\a.txt and //host/share/y.txt.',
            '',
            '[unc link](file://server/share/x.txt) and [device](%5C%5C.%5Cpipe%5Cx)',
          ].join('\n')}
        />,
      );
      await screen.findByText(/Share/, {}, LAZY);
      expect(links()).toEqual([]);
      const paragraphs = [...container.querySelectorAll('p')].map((p) => p.textContent);
      expect(paragraphs[0]).toBe(
        'Share \\\\server\\share\\x.txt and \\\\?\\C:\\x\\a.txt and //host/share/y.txt.',
      );
      expect(container.querySelectorAll('[data-file-ref="unsafe"]')).toHaveLength(3);
      expect(screen.getByText('unc link').closest('[data-blocked-link]')).not.toBeNull();
      expect(screen.getByText('device').closest('[data-blocked-link]')).not.toBeNull();
      expect(container.querySelector('a')).toBeNull();
    });

    it('turns local link targets into FileLinks; http(s) stays a web link', async () => {
      const { container } = renderWithSlots(
        <Markdown
          sessionKey={sessionKey}
          text={
            '[the guide](docs/guide.md#L3), [abs](C:/x/a.ts), [url](file:///D:/work/b.md) and ' +
            '[web](https://example.com/src/a.ts) or [`code` text](src/c.ts)'
          }
        />,
      );
      await screen.findByText('the guide', {}, LAZY);
      expect(links()).toEqual([
        { text: 'the guide', path: 'D:\\work\\sample\\docs\\guide.md', line: '3' },
        { text: 'abs', path: 'C:\\x\\a.ts', line: '' },
        { text: 'url', path: 'D:\\work\\b.md', line: '' },
        { text: 'code text', path: 'D:\\work\\sample\\src\\c.ts', line: '' },
      ]);
      expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
        'https://example.com/src/a.ts',
      ]);
      // No link inside a link: the web link text and the code in the file link are plain.
      expect(screen.getByText('web').querySelector('[data-testid="file-link"]')).toBeNull();
    });

    it('resolves relative references against baseDir instead of the cwd', async () => {
      renderWithSlots(
        <Markdown
          sessionKey={sessionKey}
          baseDir={'D:\\work\\sample\\docs'}
          text="See ./api/x.md and [up](../README.md)."
        />,
      );
      await screen.findByText(/See/, {}, LAZY);
      expect(links()).toEqual([
        { text: './api/x.md', path: 'D:\\work\\sample\\docs\\api\\x.md', line: '' },
        { text: 'up', path: 'D:\\work\\sample\\README.md', line: '' },
      ]);
    });

    it('links nothing without a session, and not in the block that is still streaming', async () => {
      const { rerender } = renderWithSlots(<Markdown text="Plain src/a.ts here." />);
      await screen.findByText(/Plain/, {}, LAZY);
      expect(links()).toEqual([]);
      const done = 'Done src/a.ts.';
      rerender(
        <FeatureSlotsProvider slots={PROBE_SLOTS}>
          <Markdown sessionKey={sessionKey} streaming text={`${done}\n\nNow src/b.ts and\n`} />
        </FeatureSlotsProvider>,
      );
      await screen.findByText(/Now/);
      expect(links().map((link) => link.text)).toEqual(['src/a.ts']);
      rerender(
        <FeatureSlotsProvider slots={PROBE_SLOTS}>
          <Markdown sessionKey={sessionKey} text={`${done}\n\nNow src/b.ts`} />
        </FeatureSlotsProvider>,
      );
      await waitFor(() => {
        expect(links().map((link) => link.text)).toEqual(['src/a.ts', 'src/b.ts']);
      });
    });
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
