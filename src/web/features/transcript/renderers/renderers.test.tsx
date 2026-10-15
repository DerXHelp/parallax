import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import type { ToolCallItem, ToolResult } from '@shared/model';
import { SAMPLE_IDS, sampleBlobId, sampleItems, sampleTime } from '@shared/samples';
import { clientStore, resetClientStore } from '@web/state/store';
import { ToolCallRow } from '../items/ToolCallRow';
import { resetExpansion } from '../state/expansion';
import { BlobLoadError, resetFullTexts, setFullTextLoader } from '../state/full-text';
import { ToolInputPreview } from '../ToolInputPreview';
import { getToolRenderer, toolRenderers } from '.';
import { genericToolRenderer } from './generic';
import { parseNumberedListing } from './read';
import { parseSearchText } from './search';

const focusDecision = vi.hoisted(() => vi.fn(() => true));
vi.mock('@web/shell/decision-focus', () => ({ focusDecision }));

// Some rows load lazy chunks (highlighter, grammars) on first use: up to 2.6 s in a full
// `pnpm test`, 5–7 s when several runs load the machine (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 30_000 });

const SESSION = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
const ESC = '\u001b';

afterEach(() => {
  resetExpansion();
  resetFullTexts();
  resetClientStore();
  focusDecision.mockClear();
});

function toolItem(patch: Partial<ToolCallItem> & Pick<ToolCallItem, 'toolName' | 'input'>): ToolCallItem {
  return sampleItems.toolCall({ id: `msg_t:${patch.toolName}`, ...patch });
}

function result(text: string, patch: Partial<ToolResult> = {}): ToolResult {
  return {
    isError: false,
    content: [{ type: 'text', text: { text, truncated: null } }],
    structured: null,
    structuredTruncated: null,
    at: sampleTime(5),
    ...patch,
  };
}

function renderRow(item: ToolCallItem) {
  return render(<ToolCallRow item={item} sessionKey={SESSION} />);
}

/** Expands the tool line (the toggle is the first button of the row). */
async function expand(user: ReturnType<typeof userEvent.setup>) {
  const toggle = screen.getAllByRole('button')[0];
  if (toggle === undefined) throw new Error('no toggle');
  if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
}

describe('registry', () => {
  it('maps the known tools and falls back to the generic renderer for every other tool', () => {
    for (const name of [
      'Bash',
      'PowerShell',
      'Edit',
      'Write',
      'Read',
      'Grep',
      'Glob',
      'Agent',
      'ExitPlanMode',
    ]) {
      expect(toolRenderers[name]).toBeDefined();
    }
    expect(getToolRenderer('FancyFutureTool')).toBe(genericToolRenderer);
    expect(getToolRenderer('toString')).toBe(genericToolRenderer);
    expect(getToolRenderer('mcp__docs__search')).not.toBe(genericToolRenderer);
  });
});

describe('expansion state', () => {
  it('survives the row being unmounted (virtualized list) and toggles with the keyboard', async () => {
    const user = userEvent.setup();
    const item = toolItem({ toolName: 'Bash', input: { command: 'dir' }, result: result('notes.txt') });
    const { unmount } = renderRow(item);
    const toggle = screen.getAllByRole('button')[0];
    if (toggle === undefined) throw new Error('no toggle');
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    unmount();
    renderRow(item);
    expect(screen.getAllByRole('button')[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-slot="terminal-output"]')?.textContent).toBe('notes.txt');
  });
});

describe('Bash / PowerShell', () => {
  it('shows command and ANSI output safely (styles as classes, escapes removed)', async () => {
    const user = userEvent.setup();
    renderRow(
      toolItem({
        toolName: 'Bash',
        input: { command: 'pnpm test', description: 'Run the tests' },
        result: result(`${ESC}[32m✓${ESC}[39m passed ${ESC}]0;title${ESC}\\<b>x</b>`),
      }),
    );
    expect(screen.getByText('Run the tests')).toBeTruthy();
    await expand(user);
    const output = document.querySelector('[data-slot="terminal-output"]');
    expect(output?.textContent).toBe('✓ passed <b>x</b>');
    expect(output?.querySelector('b')).toBeNull();
    expect(output?.querySelector('.text-success')?.textContent).toBe('✓');
    expect(output?.textContent).not.toContain(ESC);
  });

  it('normalizes PowerShell CRLF and replaces the CLI placeholder for empty output', async () => {
    const user = userEvent.setup();
    const { unmount } = renderRow(
      toolItem({ toolName: 'PowerShell', input: { command: 'ls' }, result: result('a\r\nb') }),
    );
    await expand(user);
    expect(document.querySelector('[data-slot="terminal-output"]')?.textContent).toBe('a\nb');
    unmount();
    renderRow(
      toolItem({
        toolName: 'Bash',
        input: { command: 'touch x' },
        result: result('(Bash completed with no output)'),
      }),
    );
    await expand(user);
    expect(screen.getByText('No output')).toBeTruthy();
  });

  it('shows the cap notice and loads the full text from the blob', async () => {
    const user = userEvent.setup();
    const loader = vi.fn(() => Promise.resolve('FULL OUTPUT'));
    setFullTextLoader(loader);
    renderRow(
      toolItem({
        toolName: 'Bash',
        input: { command: 'cat big.log' },
        result: {
          ...result('shortened'),
          content: [
            {
              type: 'text',
              text: { text: 'shortened', truncated: { totalChars: 250_000, blobId: sampleBlobId(9) } },
            },
          ],
        },
      }),
    );
    await expand(user);
    expect(screen.getByText('Shortened: 9 of 250,000 characters shown.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Load full text' }));
    expect(await screen.findByText('FULL OUTPUT')).toBeTruthy();
    expect(loader).toHaveBeenCalledWith(sampleBlobId(9), SESSION);
    expect(screen.getByText('Full text loaded (250,000 characters).')).toBeTruthy();
  });

  it('reports a failed load as a notice and offers a retry', async () => {
    const user = userEvent.setup();
    setFullTextLoader(() => Promise.reject(new BlobLoadError({ code: 'BLOB_NOT_FOUND', params: {} })));
    renderRow(
      toolItem({
        toolName: 'Bash',
        input: { command: 'cat big.log' },
        result: {
          ...result('x'),
          content: [
            { type: 'text', text: { text: 'x', truncated: { totalChars: 99_999, blobId: sampleBlobId(8) } } },
          ],
        },
      }),
    );
    await expand(user);
    await user.click(screen.getByRole('button', { name: 'Load full text' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(clientStore.getState().notices.at(-1)?.content).toEqual({
      error: { code: 'BLOB_NOT_FOUND', params: {} },
    });
  });
});

describe('Edit / Write', () => {
  const editInput = {
    file_path: 'D:\\work\\a.ts',
    old_string: 'const a = 1;',
    new_string: 'const a = 2;',
  };

  it('renders the diff from structuredPatch (open by default for small diffs)', () => {
    renderRow(
      toolItem({
        toolName: 'Edit',
        input: editInput,
        result: result('updated', {
          structured: {
            structuredPatch: [
              {
                oldStart: 10,
                oldLines: 2,
                newStart: 10,
                newLines: 2,
                lines: [' x', '-const a = 1;', '+const a = 2;'],
              },
            ],
          },
        }),
      }),
    );
    expect(screen.getByText('+1 −1')).toBeTruthy();
    const rows = [...document.querySelectorAll('[data-slot="diff"] tr')].map((row) => [
      row.getAttribute('data-kind'),
      row.textContent,
    ]);
    expect(rows).toEqual([
      ['hunk', '@@ -10,2 +10,2 @@'],
      ['context', '1010 x'],
      ['remove', '11−const a = 1;'],
      ['add', '11+const a = 2;'],
    ]);
  });

  it('falls back to jsdiff on old_string/new_string without structured result (history)', async () => {
    const user = userEvent.setup();
    renderRow(toolItem({ toolName: 'Edit', input: editInput, result: result('updated') }));
    await expand(user);
    expect(await screen.findByText(/line numbers count from the changed text/)).toBeTruthy();
    expect(document.querySelector('[data-slot="diff"] tr[data-kind="remove"]')?.textContent).toContain(
      'const a = 1;',
    );
    expect(document.querySelector('[data-slot="diff"] tr[data-kind="add"]')?.textContent).toContain(
      'const a = 2;',
    );
  });

  it('shows Write create as a new file', async () => {
    const user = userEvent.setup();
    renderRow(
      toolItem({
        toolName: 'Write',
        input: { file_path: 'D:\\work\\notes.txt', content: 'alpha\nbeta\n' },
        result: result('created', { structured: { type: 'create', structuredPatch: [] } }),
      }),
    );
    expect(screen.getByText('2 lines')).toBeTruthy();
    await expand(user);
    expect(screen.getByText('New file')).toBeTruthy();
    expect(
      [...document.querySelectorAll('[data-slot="diff"] tr[data-kind="add"]')].map((row) => row.textContent),
    ).toEqual(['1+alpha', '2+beta']);
  });
});

describe('Read, Grep, Glob', () => {
  it('shows the file range and the listing with line numbers', async () => {
    const user = userEvent.setup();
    renderRow(
      toolItem({
        toolName: 'Read',
        input: { file_path: 'D:\\work\\src\\a.ts' },
        result: result('170\tfoo()\n171\tbar()', {
          structured: {
            type: 'text',
            file: { filePath: 'D:\\work\\src\\a.ts', numLines: 2, startLine: 170, totalLines: 300 },
          },
        }),
      }),
    );
    expect(screen.getByText('Lines 170–171 of 300')).toBeTruthy();
    await expand(user);
    const block = document.querySelector('[data-slot="code-block"]');
    expect(block?.querySelector('code')?.textContent).toBe('foo()bar()');
    expect(block?.textContent).toContain('170171');
  });

  it('parses numbered listings and search texts', () => {
    expect(parseNumberedListing('     5\ta\n     6→b')).toEqual({ startLine: 5, code: 'a\nb' });
    expect(parseNumberedListing('no numbers')).toBeNull();
    expect(parseSearchText('Found 2 files\nC:\\a.ts\nC:\\b.ts', 'files_with_matches')).toEqual({
      kind: 'files',
      files: ['C:\\a.ts', 'C:\\b.ts'],
    });
    expect(parseSearchText('C:\\a.ts:3:foo\nC:\\a.ts:9:bar\nC:\\b.ts:1:baz', 'content')).toEqual({
      kind: 'content',
      count: 3,
      groups: [
        {
          path: 'C:\\a.ts',
          lines: [
            { line: 3, text: 'foo' },
            { line: 9, text: 'bar' },
          ],
        },
        { path: 'C:\\b.ts', lines: [{ line: 1, text: 'baz' }] },
      ],
    });
    expect(parseSearchText('No files found', 'files_with_matches')).toEqual({ kind: 'empty' });
  });

  it('lists Grep and Glob results (structured or parsed from the CLI text)', async () => {
    const user = userEvent.setup();
    const { unmount } = renderRow(
      toolItem({
        toolName: 'Grep',
        input: { pattern: 'gap', path: 'D:\\work\\src', output_mode: 'content' },
        result: result('D:\\work\\src\\sync.ts:12:  gap: true'),
      }),
    );
    await expand(user);
    expect(screen.getByText('gap: true')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    unmount();
    renderRow(
      toolItem({
        toolName: 'Glob',
        input: { pattern: '**/*.ts' },
        result: result('a.ts\nb.ts', {
          structured: { filenames: ['D:\\x\\a.ts', 'D:\\x\\b.ts'], numFiles: 2 },
        }),
      }),
    );
    expect(screen.getByText('2 files')).toBeTruthy();
    await expand(user);
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('title'))).toEqual([
      'D:\\x\\a.ts',
      'D:\\x\\b.ts',
    ]);
  });
});

describe('generic fallback, MCP, questions, todos', () => {
  it('shows input and structured result of unknown tools as JSON', async () => {
    const user = userEvent.setup();
    renderRow(
      toolItem({
        toolName: 'FancyFutureTool',
        input: { target: 'moon', speed: 3 },
        result: result('landed', { structured: { ok: true } }),
      }),
    );
    expect(screen.getByText('moon')).toBeTruthy();
    await expand(user);
    expect(document.querySelector('[data-slot="code-block"] code')?.textContent).toContain('"speed": 3');
    expect(screen.getByText('landed')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Structured result/ })).toBeTruthy();
  });

  it('labels MCP tools with their server', () => {
    renderRow(
      toolItem({ toolName: 'mcp__docs__search', input: { query: 'replay' }, result: result('3 found') }),
    );
    expect(screen.getByText('search · MCP docs')).toBeTruthy();
  });

  it('shows question answers and todo lists', async () => {
    const user = userEvent.setup();
    const { unmount } = renderRow(
      toolItem({
        toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Color?', header: 'Color', options: [{ label: 'Blue' }] }] },
        result: result('answered', { structured: { answers: { 'Color?': 'Blue' } } }),
      }),
    );
    await expand(user);
    expect(screen.getByText('Answer: Blue')).toBeTruthy();
    unmount();
    renderRow(
      toolItem({
        toolName: 'TodoWrite',
        input: {
          todos: [
            { content: 'A', status: 'completed' },
            { content: 'B', status: 'pending' },
          ],
        },
        result: result('ok'),
      }),
    );
    expect(screen.getByText('1 of 2 done')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
  });
});

describe('decision line', () => {
  it('offers "Go to decision" while the decision is open and shows the outcome afterwards', async () => {
    const user = userEvent.setup();
    const decisionId = 'dc_00000000000000000000000000000077';
    const { rerender } = renderRow(
      toolItem({
        toolName: 'Bash',
        input: { command: 'mkdir build' },
        status: 'awaiting_decision',
        result: null,
        decision: { decisionId, kind: 'permission', planVersion: null, outcome: null },
      }),
    );
    expect(screen.getAllByText('Waiting for your decision').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Go to decision' }));
    expect(focusDecision).toHaveBeenCalledWith(SESSION, decisionId);
    act(() => {
      rerender(
        <ToolCallRow
          sessionKey={SESSION}
          item={toolItem({
            toolName: 'Bash',
            input: { command: 'mkdir build' },
            status: 'running',
            result: null,
            decision: {
              decisionId,
              kind: 'permission',
              planVersion: null,
              outcome: { type: 'allowed', remember: 'localSettings', acceptEdits: false },
            },
          })}
        />,
      );
    });
    expect(screen.getByText('Allowed and remembered for this project (local settings)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Go to decision' })).toBeNull();
  });
});

describe('ToolInputPreview slot', () => {
  it('previews Edit as a diff, Write as new content, Bash as the command and others as JSON', async () => {
    const { unmount } = render(
      <ToolInputPreview
        toolName="Edit"
        input={{ file_path: 'a.ts', old_string: 'one', new_string: 'two' }}
      />,
    );
    const diff = await screen.findByText('two');
    expect(diff.closest('tr')?.getAttribute('data-kind')).toBe('add');
    unmount();
    const { unmount: unmountWrite } = render(
      <ToolInputPreview toolName="Write" input={{ file_path: 'b.txt', content: 'hello' }} />,
    );
    expect(screen.getByText('Written content')).toBeTruthy();
    unmountWrite();
    const { unmount: unmountBash } = render(
      <ToolInputPreview toolName="Bash" input={{ command: 'rm -rf build' }} />,
    );
    expect(within(document.body).getByText('rm -rf build')).toBeTruthy();
    unmountBash();
    render(<ToolInputPreview toolName="mcp__x__y" input={{ url: 'https://example.com' }} />);
    expect(document.querySelector('[data-slot="tool-input-preview"] code')?.textContent).toContain('"url"');
  });
});
