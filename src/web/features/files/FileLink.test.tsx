import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { Command } from '@shared/protocol';
import { SAMPLE_IDS, sampleItems } from '@shared/samples';
import type { RunningScenario } from '@web/playground/PlaygroundScenario';
import { registerShellRequestHandler, type ShellRequestOf } from '@web/shell/requests';
import { FAKE_FILE_PATHS } from '@web/state/fake-host';
import { useNotices } from '@web/state/notices';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { FileLink } from './FileLink';
import { statCache } from './state/stat-cache';
import { FILES_SESSION_KEY, startFilesScenario } from './testing';

// 0.1–0.5 s per test alone, up to 4.4 s under parallel load (menus, tooltips; R5W-04).
vi.setConfig({ testTimeout: 30_000 });

let running: RunningScenario;
let opened: ShellRequestOf<'openFile'>[];
let removeHandler: () => void;

function commandsNamed<N extends Command['name']>(name: N): Extract<Command, { name: N }>[] {
  return running.host.commands.filter((cmd): cmd is Extract<Command, { name: N }> => cmd.name === name);
}

/** Lets every microtask run (MemoryTransport delivers ops and answers in microtasks). */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Sends the waiting batch at once instead of sleeping past the 50 ms batch timer (a wall-clock
 * assumption, R5W-11; the timer itself is tested with fake timers in state/stat-cache.test.ts):
 * first pending ops arrive and the links' effects queue their paths, then the batch goes out and
 * the answers arrive.
 */
async function flushStats(): Promise<void> {
  await act(nextTask);
  await act(async () => {
    statCache.flush();
    await nextTask();
  });
}

function Notices() {
  const notices = useNotices();
  return (
    <ul aria-label="notices">
      {notices.map((notice) => (
        <li key={notice.id}>{'error' in notice.content ? notice.content.error.code : notice.content.text}</li>
      ))}
    </ul>
  );
}

function renderLink(ui: React.ReactNode) {
  return render(
    <TooltipProvider>
      {ui}
      <Notices />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  running = startFilesScenario();
  opened = [];
  removeHandler = registerShellRequestHandler('openFile', (request) => {
    opened.push(request);
    return true;
  });
});

afterEach(() => {
  removeHandler();
  running.stop();
  resetClientStore();
  statCache.clear();
});

describe('FileLink (WP-54, L15)', () => {
  it.each([
    ['UNC', '\\\\server\\share\\notes.md'],
    ['device', '\\\\?\\C:\\secret.txt'],
    ['ADS', 'D:\\work\\sample\\a.md:hidden'],
    ['relative', 'docs\\guide.md'],
  ])('a %s path stays plain text and sends no command', async (_, path) => {
    renderLink(
      <>
        <FileLink sessionKey={FILES_SESSION_KEY} path={path} verify />
        <FileLink sessionKey={FILES_SESSION_KEY} path={path} />
        <FileLink sessionKey={FILES_SESSION_KEY} path={path} variant="menu" />
      </>,
    );
    await flushStats();
    expect(screen.queryByRole('button')).toBeNull();
    const texts = document.querySelectorAll('[data-slot="file-link"]');
    expect(texts).toHaveLength(2);
    for (const text of texts) expect(text.getAttribute('data-state')).toBe('unsafe');
    expect(commandsNamed('file.statMany')).toEqual([]);
    expect(running.host.commands.filter((cmd) => cmd.name.startsWith('file'))).toEqual([]);
  });

  it('verify: one batched file.statMany; a link only after ok:true, text otherwise', async () => {
    renderLink(
      <p>
        <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.readme} verify />
        <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.missing} verify />
        <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.outside} verify />
        <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.readme} verify variant="chip" />
      </p>,
    );
    // Before the answer: text, no link.
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelectorAll('[data-state="checking"]')).toHaveLength(4);
    await flushStats();
    expect(commandsNamed('file.statMany')).toEqual([
      {
        name: 'file.statMany',
        entryId: SAMPLE_IDS.entry,
        paths: [FAKE_FILE_PATHS.readme, FAKE_FILE_PATHS.missing, FAKE_FILE_PATHS.outside],
      },
    ]);
    const links = screen.getAllByRole('button');
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('data-variant')).toBe('inline');
    expect(links[0]?.getAttribute('data-kind')).toBe('markdown');
    expect(document.querySelector('[data-state="missing"]')?.textContent).toBe('sample\\missing.md');
    const refused = document.querySelector<HTMLElement>('[data-state="refused"]');
    expect(refused).not.toBeNull();
    // The reason is reachable by keyboard: focus shows the tooltip.
    act(() => {
      refused?.focus();
    });
    expect((await screen.findByRole('tooltip')).textContent).toBe('Not shared with this session');
  });

  it('variants: inline (path tail, full path as tooltip), chip (name + tail), menu (actions button only)', async () => {
    const user = userEvent.setup();
    renderLink(
      <>
        <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.main} line={12} />
        <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.image} variant="chip" verify />
        <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.guide} variant="menu" />
      </>,
    );
    await flushStats();
    const inline = screen.getByRole('button', { name: 'src\\main.ts:12' });
    // The link token (index.css --link): >= 4.5:1 also on inline code (V4-04).
    expect(inline.className).toContain('text-link');
    await user.hover(inline);
    expect((await screen.findByRole('tooltip')).textContent).toBe(`${FAKE_FILE_PATHS.main} – line 12`);
    const chip = screen.getByRole('button', { name: /diagram\.png/ });
    expect(chip.getAttribute('data-variant')).toBe('chip');
    expect(chip.getAttribute('data-kind')).toBe('image');
    expect(chip.textContent).toBe('diagram.pngsample\\assets\\diagram.png');
    const menu = screen.getByRole('button', { name: 'Actions for guide.md' });
    await user.click(menu);
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Open in viewer',
      'Open in editor',
      'Show in Explorer',
      'Open with default program',
      'Copy path',
    ]);
  });

  it('click → openFile request; Ctrl+click and middle click → file.open editor with line/col', async () => {
    const user = userEvent.setup();
    renderLink(<FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.main} line={7} col={3} />);
    const link = screen.getByRole('button');
    await user.click(link);
    expect(opened).toEqual([
      { kind: 'openFile', sessionKey: FILES_SESSION_KEY, path: FAKE_FILE_PATHS.main, line: 7, col: 3 },
    ]);
    await user.keyboard('{Control>}');
    await user.click(link);
    await user.keyboard('{/Control}');
    fireEvent.mouseDown(link, { button: 1 });
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(opened).toHaveLength(1);
    expect(running.host.fileOpens).toEqual([
      {
        name: 'file.open',
        entryId: SAMPLE_IDS.entry,
        path: FAKE_FILE_PATHS.main,
        target: 'editor',
        line: 7,
        col: 3,
      },
      {
        name: 'file.open',
        entryId: SAMPLE_IDS.entry,
        path: FAKE_FILE_PATHS.main,
        target: 'editor',
        line: 7,
        col: 3,
      },
    ]);
  });

  it('context menu: Explorer and default program via file.open; a failure becomes an error notice', async () => {
    const user = userEvent.setup();
    renderLink(<FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.pdf} line={4} />);
    fireEvent.contextMenu(screen.getByRole('button'));
    await user.click(await screen.findByRole('menuitem', { name: 'Show in Explorer' }));
    fireEvent.contextMenu(screen.getByRole('button'));
    running.host.fileOpenError = makeError('OPEN_FAILED', { reason: 'not_gui' });
    await user.click(await screen.findByRole('menuitem', { name: 'Open with default program' }));
    expect(running.host.fileOpens.map((cmd) => [cmd.target, cmd.line])).toEqual([
      ['explorer', null],
      ['default', null],
    ]);
    expect(within(screen.getByRole('list', { name: 'notices' })).getByText('OPEN_FAILED')).toBeTruthy();
  });

  it('no default program for other extensions, no editor for folders', async () => {
    const user = userEvent.setup();
    renderLink(
      <>
        <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.main} variant="menu" />
        <FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.folder} variant="menu" verify />
      </>,
    );
    await flushStats();
    const [mainMenu, folderMenu] = screen.getAllByRole('button');
    if (mainMenu === undefined || folderMenu === undefined) throw new Error('menus missing');
    await user.click(mainMenu);
    expect(screen.queryByRole('menuitem', { name: 'Open with default program' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(folderMenu);
    expect(screen.queryByRole('menuitem', { name: 'Open in editor' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Show in Explorer' })).toBeTruthy();
  });

  it('a remote host offers neither editor nor Explorer; Ctrl+click falls back to the viewer', async () => {
    const user = userEvent.setup();
    const remote = makeSessionKey('remote-1', SAMPLE_IDS.entry);
    renderLink(<FileLink sessionKey={remote} path={FAKE_FILE_PATHS.readme} />);
    fireEvent.contextMenu(screen.getByRole('button'));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Open in viewer', 'Copy path']);
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('button'));
    await user.keyboard('{/Control}');
    expect(opened).toEqual([
      { kind: 'openFile', sessionKey: remote, path: FAKE_FILE_PATHS.readme, line: null, col: null },
    ]);
    expect(running.host.fileOpens).toEqual([]);
  });

  it('a finished write on the same file drops the cached answer and checks again', async () => {
    renderLink(<FileLink sessionKey={FILES_SESSION_KEY} path={FAKE_FILE_PATHS.guide} verify />);
    await flushStats();
    expect(commandsNamed('file.statMany')).toHaveLength(1);
    act(() => {
      running.host.emitFileToolCall(SAMPLE_IDS.entry, {
        toolName: 'Edit',
        path: FAKE_FILE_PATHS.guide.toUpperCase(),
      });
    });
    await flushStats();
    expect(commandsNamed('file.statMany')).toHaveLength(2);
    // A tool call on another file changes nothing.
    act(() => {
      running.host.emitFileToolCall(SAMPLE_IDS.entry, { toolName: 'Write', path: FAKE_FILE_PATHS.readme });
      running.host.pushOps(SAMPLE_IDS.entry, [
        { op: 'item.upsert', item: sampleItems.userMessage({ id: 'u9', order: 99 }) },
      ]);
    });
    await flushStats();
    expect(commandsNamed('file.statMany')).toHaveLength(2);
  });
});
