import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { SAMPLE_IDS, sampleSessionFile, sampleTime } from '@shared/samples';
import type { RunningScenario } from '@web/playground/PlaygroundScenario';
import { registerShellRequestHandler, type ShellRequestOf } from '@web/shell/requests';
import { FAKE_FILE_PATHS } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { FilesPanel } from './FilesPanel';
import { SESSION_FILES_DEBOUNCE_MS } from './state/session-files';
import { FILES_SESSION_KEY, installResizeObserver, startFilesScenario } from './testing';

// Under 0.5 s per test alone, up to 5.3 s under parallel load (typing into the filter, menus; R5W-04).
vi.setConfig({ testTimeout: 30_000 });

let running: RunningScenario;
let restoreResizeObserver: () => void;
let opened: ShellRequestOf<'openFile'>[];
let removeHandler: () => void;

function listCount(): number {
  return running.host.commands.filter((cmd) => cmd.name === 'files.session').length;
}

function rowPaths(): string[] {
  return [...document.querySelectorAll('[data-slot="files-row"]')].map(
    (row) => row.getAttribute('data-path') ?? '',
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index++) await Promise.resolve();
  });
}

function renderPanel() {
  return render(
    <TooltipProvider>
      <FilesPanel sessionKey={FILES_SESSION_KEY} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  restoreResizeObserver = installResizeObserver({ viewport: 600, item: 48 });
  running = startFilesScenario();
  opened = [];
  removeHandler = registerShellRequestHandler('openFile', (request) => {
    opened.push(request);
    return true;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  removeHandler();
  running.stop();
  resetClientStore();
  restoreResizeObserver();
});

describe('FilesPanel (WP-54, ADR-145)', () => {
  it('lists the files newest first with paths relative to the cwd, op badges and times', async () => {
    running.host.sessionFiles.set(SAMPLE_IDS.entry, [
      sampleSessionFile({ path: FAKE_FILE_PATHS.readme, ops: ['read'], lastAt: sampleTime(10) }),
      sampleSessionFile({ path: FAKE_FILE_PATHS.main, ops: ['read', 'edited'], lastAt: sampleTime(50) }),
      sampleSessionFile({ path: FAKE_FILE_PATHS.plan, ops: ['plan'], lastAt: sampleTime(30) }),
    ]);
    renderPanel();
    await waitFor(() => {
      expect(rowPaths()).toEqual([FAKE_FILE_PATHS.main, FAKE_FILE_PATHS.plan, FAKE_FILE_PATHS.readme]);
    });
    const list = screen.getByRole('list', { name: 'Files Claude read or wrote' });
    const rows = within(list).getAllByRole('listitem');
    const [main, plan, readme] = rows;
    if (main === undefined || plan === undefined || readme === undefined) throw new Error('rows missing');
    // Inside the cwd: relative; outside: the full path.
    expect(main.textContent).toContain('main.tssrc\\main.ts');
    expect(plan.textContent).toContain(`sample.md${FAKE_FILE_PATHS.plan}`);
    // README.md lies directly in the cwd: the name alone.
    expect(within(readme).getAllByText('README.md')).toHaveLength(1);
    expect([...main.querySelectorAll('[data-op]')].map((badge) => badge.textContent)).toEqual([
      'read',
      'edited',
    ]);
    expect(main.querySelector('time')?.getAttribute('dateTime')).toBe(sampleTime(50));
    expect(screen.getByText('3 files')).toBeTruthy();
  });

  it('filters with the fuzzy filter over the relative path and the name', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(rowPaths().length).toBeGreaterThan(3);
    });
    await user.type(screen.getByRole('searchbox', { name: 'Filter files' }), 'guide');
    expect(rowPaths()).toEqual([FAKE_FILE_PATHS.guide]);
    expect(screen.getByText('1 file')).toBeTruthy();
    await user.clear(screen.getByRole('searchbox', { name: 'Filter files' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter files' }), 'zzzz');
    expect(rowPaths()).toEqual([]);
    expect(screen.getByText('No file matches “zzzz”.')).toBeTruthy();
  });

  it('click opens the viewer; the "…" menu offers the file actions', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(rowPaths()[0]).toBe(FAKE_FILE_PATHS.main);
    });
    const row = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(FAKE_FILE_PATHS.main)}"]`);
    if (row === null) throw new Error('row missing');
    await user.click(within(row).getAllByRole('button')[0] ?? row);
    expect(opened).toEqual([
      { kind: 'openFile', sessionKey: FILES_SESSION_KEY, path: FAKE_FILE_PATHS.main, line: null, col: null },
    ]);
    await user.click(within(row).getByRole('button', { name: 'Actions for main.ts' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open in viewer',
      'Open in editor',
      'Show in Explorer',
      'Copy path',
    ]);
  });

  it('refreshes 2 s after the last finished file tool call (debounced)', async () => {
    renderPanel();
    // Subscribed and loaded with real timers, then the debounce runs on fake ones.
    await waitFor(() => {
      expect(rowPaths().length).toBeGreaterThan(0);
    });
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
    expect(listCount()).toBe(1);
    /** The connection applies ops once per frame. */
    const emit = (call: Parameters<typeof running.host.emitFileToolCall>[1]) => {
      running.host.emitFileToolCall(SAMPLE_IDS.entry, call);
      act(() => {
        vi.advanceTimersByTime(20);
      });
    };
    const advance = (ms: number) => {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    };
    emit({ toolName: 'Write', path: 'D:\\work\\sample\\new.md' });
    advance(SESSION_FILES_DEBOUNCE_MS - 500);
    emit({ toolName: 'Edit', path: FAKE_FILE_PATHS.main });
    advance(SESSION_FILES_DEBOUNCE_MS - 1);
    expect(listCount()).toBe(1);
    advance(1);
    await settle();
    expect(listCount()).toBe(2);
    expect(rowPaths()[0]).toBe(FAKE_FILE_PATHS.main);
    expect(rowPaths()).toContain('D:\\work\\sample\\new.md');
    // A running call is not finished yet: no refresh.
    emit({ path: FAKE_FILE_PATHS.readme, status: 'running' });
    advance(SESSION_FILES_DEBOUNCE_MS * 2);
    await settle();
    expect(listCount()).toBe(2);
  });

  it('shows the empty state', async () => {
    running.host.sessionFiles.set(SAMPLE_IDS.entry, []);
    renderPanel();
    expect(await screen.findByText(/^No files yet\./)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('a failed load is an alert with "Try again"; a cut list says so', async () => {
    const user = userEvent.setup();
    running.host.sessionFilesTruncated = true;
    running.host.failNext('files.session', makeError('INTERNAL_ERROR'));
    renderPanel();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The list could not be loaded');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(rowPaths().length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Only the newest files are listed.')).toBeTruthy();
  });
});
