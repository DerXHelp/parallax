import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import { SAMPLE_IDS, SAMPLE_REMOTE_HOST_ID } from '@shared/samples';
import { requestTerminalTarget, resetTerminalTargets } from '@web/shell/navigation/session-actions';
import { installShortcutListener, useEscapeHandler } from '@web/shell/shortcuts';
import { clientStore, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { createFakeEngineFactory, type FakeEngine } from './lib/fake-engine';
import { TerminalEnvironmentContext } from './state/environment';
import { resetTerminalStores } from './state/terminals';
import { TerminalPanel } from './TerminalPanel';
import {
  FakeTerminalServer,
  fakeTerminalEnvironment,
  remoteTerminalSocketUrl,
  sampleTerminalId,
  sampleTerminalInfo,
  TERMINAL_SESSION_KEY,
  TERMINAL_SOCKET_URL,
} from './testing';

// Menus and several server round trips per test: well under a second alone, more under parallel load.
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  resetTerminalStores();
  resetTerminalTargets();
  resetClientStore();
});

function setup(
  prepare: (server: FakeTerminalServer) => void = () => undefined,
  sessionKey: string = TERMINAL_SESSION_KEY,
) {
  const server = new FakeTerminalServer();
  prepare(server);
  const engines = createFakeEngineFactory();
  const copyText = vi.fn(async () => Promise.resolve(true));
  const readClipboard = vi.fn(async () => Promise.resolve<string | null>('echo pasted'));
  const env = fakeTerminalEnvironment(engines.factory, server.factory, { copyText, readClipboard });
  const wrap = (children: ReactNode) => (
    <TooltipProvider>
      <TerminalEnvironmentContext value={env}>{children}</TerminalEnvironmentContext>
    </TooltipProvider>
  );
  const view = render(wrap(<TerminalPanel sessionKey={sessionKey} />));
  return { server, engines: engines.engines, env, copyText, readClipboard, view, wrap };
}

function engineAt(engines: FakeEngine[], index: number): FakeEngine {
  const engine = engines[index];
  if (engine === undefined) throw new Error(`no engine ${String(index)}`);
  return engine;
}

function activeView(): HTMLElement {
  const view = document.querySelector<HTMLElement>('[data-slot="terminal-view"][data-active="true"]');
  if (view === null) throw new Error('no active terminal view');
  return view;
}

describe('TerminalPanel (WP-99b)', () => {
  it('opens one terminal with the default shell on the first connect, attaches it and takes the focus', async () => {
    const { server, engines } = setup();
    await waitFor(() => {
      expect(server.sentOfType('open')).toHaveLength(1);
    });
    expect(server.sentOfType('open')[0]).toMatchObject({ shell: 'cmd', cols: 80, rows: 24 });
    const tab = await screen.findByRole('tab', { name: 'cmd 1' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[data-slot="terminal-panel"]')).not.toBeNull();

    // The view opened its engine, attached with the fitted size and got the focus.
    await waitFor(() => {
      expect(server.sentOfType('attach')).toHaveLength(1);
    });
    const terminalId = sampleTerminalId(100);
    expect(server.sentOfType('attach')[0]).toEqual({ type: 'attach', terminalId, cols: 100, rows: 30 });
    const engine = engineAt(engines, 0);
    expect(activeView().getAttribute('data-terminal-id')).toBe(terminalId);
    expect(document.activeElement).toBe(engine.textarea);
    expect(activeView().querySelector('.xterm-helper-textarea')).toBe(engine.textarea);

    // Output of its channel reaches the engine; typed keys go out as input.
    act(() => {
      server.emit(terminalId, 'C:\\work\\sample>');
    });
    expect(engine.output).toBe('C:\\work\\sample>');
    act(() => {
      engine.type('dir\r');
    });
    await waitFor(() => {
      expect(server.sentOfType('input')).toEqual([{ type: 'input', terminalId, data: 'dir\r' }]);
    });
  });

  it('opens nothing automatically when terminals exist, and the empty state after all were closed', async () => {
    const { server } = setup((fake) => {
      fake.items = [
        sampleTerminalInfo({ terminalId: sampleTerminalId(1), shell: 'cmd' }),
        sampleTerminalInfo({ terminalId: sampleTerminalId(2), shell: 'powershell' }),
        sampleTerminalInfo({ terminalId: sampleTerminalId(3), shell: 'cmd' }),
      ];
    });
    const user = userEvent.setup();
    expect(await screen.findByRole('tab', { name: 'cmd 1' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'PowerShell 1' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'cmd 2' })).toBeTruthy();

    for (const name of ['cmd 1', 'PowerShell 1', 'cmd 2']) {
      await user.click(screen.getByRole('button', { name: `Close ${name}` }));
      await waitFor(() => {
        expect(screen.queryByRole('tab', { name })).toBeNull();
      });
    }
    const empty = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="terminal-empty"]');
      expect(found).not.toBeNull();
      return found;
    });
    expect(empty?.textContent).toContain('No terminal open');
    expect(server.sentOfType('open')).toEqual([]);
    expect(server.sentOfType('close')).toHaveLength(3);

    // The empty state offers every shell.
    await user.click(screen.getByRole('button', { name: 'Git Bash' }));
    expect(await screen.findByRole('tab', { name: 'Git Bash 1' })).toBeTruthy();
    expect(server.sentOfType('open')).toHaveLength(1);
    expect(server.sentOfType('open')[0]?.shell).toBe('gitbash');
  });

  it('"+" lists the default shell first and opens the chosen one as the active terminal', async () => {
    clientStore.setState((state) => ({
      localSettings: {
        ...state.localSettings,
        console: { ...state.localSettings.console, defaultShell: 'powershell' },
      },
    }));
    const { server } = setup();
    const user = userEvent.setup();
    expect(await screen.findByRole('tab', { name: 'PowerShell 1' })).toBeTruthy();
    expect(server.sentOfType('open')[0]?.shell).toBe('powershell');

    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('data-choice'))).toEqual(['powershell', 'cmd', 'gitbash']);
    expect(items[0]?.textContent).toContain('Default');
    await user.click(within(menu).getByRole('menuitem', { name: /Command Prompt/ }));

    const tab = await screen.findByRole('tab', { name: 'cmd 1' });
    await waitFor(() => {
      expect(tab.getAttribute('aria-selected')).toBe('true');
    });
    expect(server.sentOfType('open').map((message) => message.shell)).toEqual(['powershell', 'cmd']);
    // WP-109 (CI): the focus is in the new terminal, not back on "+".
    await waitFor(() => {
      expect(document.activeElement).toBe(activeView().querySelector('.xterm-helper-textarea'));
    });
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'New terminal' }));
  });

  it('shows the exit bar of an exited terminal: Restart opens the same shell again, Close removes it', async () => {
    const { server } = setup((fake) => {
      fake.items = [sampleTerminalInfo({ terminalId: sampleTerminalId(1), shell: 'powershell' })];
    });
    const user = userEvent.setup();
    await screen.findByRole('tab', { name: 'PowerShell 1' });
    await waitFor(() => {
      expect(server.sentOfType('attach')).toHaveLength(1);
    });
    act(() => {
      server.exit(sampleTerminalId(1), 3);
    });
    const bar = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="terminal-exit-bar"]');
      expect(found).not.toBeNull();
      return found;
    });
    expect(bar?.textContent).toContain('Exited with code 3');
    expect(screen.getByRole('tab', { name: 'PowerShell 1 (exited)' })).toBeTruthy();

    await user.click(within(bar ?? document.body).getByRole('button', { name: 'Restart' }));
    await waitFor(() => {
      expect(server.sentOfType('open')).toHaveLength(1);
    });
    expect(server.sentOfType('close')).toEqual([{ type: 'close', terminalId: sampleTerminalId(1) }]);
    expect(server.sentOfType('open')[0]?.shell).toBe('powershell');
    const restarted = await screen.findByRole('tab', { name: 'PowerShell 1' });
    await waitFor(() => {
      expect(restarted.getAttribute('aria-selected')).toBe('true');
    });
    expect(activeView().getAttribute('data-terminal-id')).toBe(sampleTerminalId(100));

    act(() => {
      server.exit(sampleTerminalId(100), null);
    });
    const second = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="terminal-exit-bar"]');
      expect(found?.textContent).toContain('Exited');
      return found;
    });
    await user.click(within(second ?? document.body).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(server.sentOfType('close')).toHaveLength(2);
    });
    expect(await screen.findByText('No terminal open')).toBeTruthy();
    expect(server.sentOfType('open')).toHaveLength(1);
  });

  it('shows a failed request inline with the translated error code', async () => {
    const { server } = setup((fake) => {
      fake.failOpen = makeError('TERMINAL_LIMIT_REACHED', { scope: 'entry', max: 4 });
    });
    const user = userEvent.setup();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Too many terminals are open. Close one first.');
    // The automatic first terminal failed – the empty state offers the shells.
    expect(await screen.findByText('No terminal open')).toBeTruthy();
    expect(server.sentOfType('open')).toHaveLength(1);

    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('shows the hint TERMINAL_UNAVAILABLE when the server has no pseudo console', async () => {
    const { server } = setup((fake) => {
      fake.available = false;
      fake.unavailableError = makeError('TERMINAL_UNAVAILABLE', { reason: 'ffi' });
    });
    const hint = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="terminal-unavailable"]');
      expect(found).not.toBeNull();
      return found;
    });
    expect(hint?.textContent).toContain('The terminal is not available on this computer.');
    expect(server.sentOfType('open')).toEqual([]);
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('re-attaches after a lost connection and clears the screen for the replay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { server, engines } = setup((fake) => {
      fake.items = [sampleTerminalInfo({ terminalId: sampleTerminalId(1) })];
      fake.output.set(sampleTerminalId(1), 'old prompt>');
    });
    await waitFor(() => {
      expect(engineAt(engines, 0).output).toBe('old prompt>');
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      act(() => {
        server.socket.serverClose(1006);
      });
      expect(await screen.findByText('Connection to the terminal lost – reconnecting…')).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      await waitFor(() => {
        expect(server.sockets).toHaveLength(2);
        expect(server.socket.sentOfType('attach')).toHaveLength(1);
      });
      await waitFor(() => {
        expect(engineAt(engines, 0).resets).toBe(2);
      });
      expect(engineAt(engines, 0).output).toBe('old prompt>');
      expect(screen.queryByText('Connection to the terminal lost – reconnecting…')).toBeNull();
      expect(engines).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('keeps Esc inside the terminal: the side panel (an outer Esc handler) stays open', async () => {
    const outer = vi.fn(() => true);
    function SidePanel({ children }: { children: ReactNode }) {
      const ref = useRef<HTMLElement>(null);
      useEscapeHandler(outer, true, { scopeRef: ref });
      return (
        <aside ref={ref} data-slot="side-panel" tabIndex={-1}>
          {children}
        </aside>
      );
    }
    const stop = installShortcutListener();
    try {
      const server = new FakeTerminalServer();
      const engines = createFakeEngineFactory();
      const env = fakeTerminalEnvironment(engines.factory, server.factory);
      render(
        <TooltipProvider>
          <TerminalEnvironmentContext value={env}>
            <SidePanel>
              <TerminalPanel sessionKey={TERMINAL_SESSION_KEY} />
            </SidePanel>
          </TerminalEnvironmentContext>
        </TooltipProvider>,
      );
      await screen.findByRole('tab', { name: 'cmd 1' });
      const engine = await waitFor(() => {
        const found = engines.engines[0];
        expect(found?.textarea).toBeTruthy();
        return found;
      });
      const textarea = engine?.textarea;
      if (textarea === null || textarea === undefined) throw new Error('no textarea');
      await waitFor(() => {
        expect(document.activeElement).toBe(textarea);
      });
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(engine?.keys).toEqual(['Escape']);
      expect(outer).not.toHaveBeenCalled();

      // Outside the terminal (on its tab) Esc reaches the panel as usual.
      fireEvent.keyDown(screen.getByRole('tab', { name: 'cmd 1' }), { key: 'Escape' });
      expect(outer).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it('context menu: Clear, Select all + Copy, Paste and the screen reader mode', async () => {
    const { server, engines, copyText, readClipboard } = setup((fake) => {
      fake.items = [sampleTerminalInfo({ terminalId: sampleTerminalId(1) })];
      fake.output.set(sampleTerminalId(1), 'C:\\work>');
    });
    const user = userEvent.setup();
    await waitFor(() => {
      expect(engineAt(engines, 0).output).toBe('C:\\work>');
    });
    const engine = engineAt(engines, 0);
    const screenArea = activeView().querySelector<HTMLElement>('[data-slot="terminal-screen"]');
    if (screenArea === null) throw new Error('no terminal screen');

    const openMenu = async () => {
      fireEvent.contextMenu(screenArea);
      return screen.findByRole('menu');
    };

    let menu = await openMenu();
    expect(within(menu).getByRole('menuitem', { name: /Copy/ }).getAttribute('aria-disabled')).toBe('true');
    await user.click(within(menu).getByRole('menuitem', { name: 'Clear' }));
    expect(engine.clears).toBe(1);

    menu = await openMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Select all' }));
    expect(engine.selection).toBe('C:\\work>');
    menu = await openMenu();
    await user.click(within(menu).getByRole('menuitem', { name: /Copy/ }));
    expect(copyText).toHaveBeenCalledWith('C:\\work>');
    expect(engine.selection).toBe('');

    menu = await openMenu();
    await user.click(within(menu).getByRole('menuitem', { name: /Paste/ }));
    await waitFor(() => {
      expect(engine.pasted).toEqual(['echo pasted']);
    });
    expect(readClipboard).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(server.sentOfType('input').at(-1)?.data).toBe('echo pasted');
    });

    menu = await openMenu();
    const toggle = within(menu).getByRole('menuitemcheckbox', { name: 'Screen reader mode' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await waitFor(() => {
      expect(engine.screenReaderMode).toBe(true);
    });
    menu = await openMenu();
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Screen reader mode' }));
    await waitFor(() => {
      expect(engine.screenReaderMode).toBe(false);
    });
  });

  it('reopened, it shows the terminal active before and nothing of the old mount meanwhile', async () => {
    const { server, engines, view, wrap } = setup((fake) => {
      fake.items = [
        sampleTerminalInfo({ terminalId: sampleTerminalId(1), shell: 'cmd' }),
        sampleTerminalInfo({ terminalId: sampleTerminalId(2), shell: 'powershell' }),
      ];
      fake.output.set(sampleTerminalId(2), 'PS C:\\work>');
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'PowerShell 1' }));
    await waitFor(() => {
      expect(activeView().getAttribute('data-terminal-id')).toBe(sampleTerminalId(2));
    });
    expect(engines).toHaveLength(2);
    view.unmount();

    render(wrap(<TerminalPanel sessionKey={TERMINAL_SESSION_KEY} />));
    // Before the new socket answered: no views of the old list, no new engines.
    expect(document.querySelector('[data-slot="terminal-view"]')).toBeNull();
    expect(engines).toHaveLength(2);
    const tab = await screen.findByRole('tab', { name: 'PowerShell 1' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => {
      expect(engineAt(engines, 2).output).toBe('PS C:\\work>');
    });
    // Only the active terminal opened an engine and attached on the new socket.
    expect(engines).toHaveLength(3);
    expect(server.socket.sentOfType('attach').map((message) => message.terminalId)).toEqual([
      sampleTerminalId(2),
    ]);
    expect(server.sentOfType('open')).toEqual([]);
  });

  it('detaches, disposes the engine and closes the socket on unmount', async () => {
    const { server, engines, view } = setup((fake) => {
      fake.items = [sampleTerminalInfo({ terminalId: sampleTerminalId(1) })];
    });
    await waitFor(() => {
      expect(server.sentOfType('attach')).toHaveLength(1);
    });
    view.unmount();
    expect(server.socket.sentOfType('detach')).toEqual([{ type: 'detach', terminalId: sampleTerminalId(1) }]);
    expect(engineAt(engines, 0).disposed).toBe(true);
    expect(server.socket.closedWith).toBe(1000);
  });

  it('renames a tab: double click, F2 or the context menu; Esc cancels, empty = default name', async () => {
    const { server } = setup((fake) => {
      fake.items = [
        sampleTerminalInfo({ terminalId: sampleTerminalId(1), shell: 'cmd' }),
        sampleTerminalInfo({ terminalId: sampleTerminalId(2), shell: 'powershell', title: 'server' }),
      ];
    });
    const user = userEvent.setup();
    const outerEscape = vi.fn(() => true);
    function OuterEscape() {
      useEscapeHandler(outerEscape);
      return null;
    }
    const stop = installShortcutListener();
    try {
      render(<OuterEscape />);
      // A given name replaces the default name.
      expect(await screen.findByRole('tab', { name: 'server' })).toBeTruthy();

      await user.dblClick(screen.getByRole('tab', { name: 'cmd 1' }));
      const field = screen.getByRole('textbox', { name: 'Name of cmd 1' });
      expect(document.activeElement).toBe(field);
      await user.keyboard('build{Enter}');
      expect(server.sentOfType('rename')).toEqual([
        { type: 'rename', terminalId: sampleTerminalId(1), title: 'build' },
      ]);
      expect(await screen.findByRole('tab', { name: 'build' })).toBeTruthy();

      // F2 on the tab; Esc cancels the edit only (the outer Esc handler – the side panel – stays out).
      screen.getByRole('tab', { name: 'build' }).focus();
      await user.keyboard('{F2}');
      await user.keyboard('other{Escape}');
      expect(document.querySelector('[data-slot="terminal-tab-name"]')).toBeNull();
      expect(outerEscape).not.toHaveBeenCalled();
      expect(server.sentOfType('rename')).toHaveLength(1);

      // Context menu → Rename; an empty name goes back to the default name.
      fireEvent.contextMenu(screen.getByRole('tab', { name: 'server' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
      await user.clear(screen.getByRole('textbox', { name: 'Name of server' }));
      await user.keyboard('{Enter}');
      expect(server.sentOfType('rename').at(-1)).toEqual({
        type: 'rename',
        terminalId: sampleTerminalId(2),
        title: null,
      });
      expect(await screen.findByRole('tab', { name: 'PowerShell 1' })).toBeTruthy();
    } finally {
      stop();
    }
  });

  it('moves a tab with the context menu and by dragging; the server keeps the order', async () => {
    const { server } = setup((fake) => {
      fake.items = [
        sampleTerminalInfo({ terminalId: sampleTerminalId(1), shell: 'cmd' }),
        sampleTerminalInfo({ terminalId: sampleTerminalId(2), shell: 'powershell' }),
        sampleTerminalInfo({ terminalId: sampleTerminalId(3), shell: 'gitbash' }),
      ];
    });
    const user = userEvent.setup();
    const order = () => screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(await screen.findByRole('tab', { name: 'cmd 1' })).toBeTruthy();
    expect(order()).toEqual(['cmd 1', 'PowerShell 1', 'Git Bash 1']);

    // The first tab cannot move further left.
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'cmd 1' }));
    const left = await screen.findByRole('menuitem', { name: 'Move left' });
    expect(left.getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('menuitem', { name: 'Move right' }));
    expect(server.sentOfType('move')).toEqual([{ type: 'move', terminalId: sampleTerminalId(1), index: 1 }]);
    await waitFor(() => {
      expect(order()).toEqual(['PowerShell 1', 'cmd 1', 'Git Bash 1']);
    });
    expect(server.items.map((item) => item.terminalId)).toEqual([
      sampleTerminalId(2),
      sampleTerminalId(1),
      sampleTerminalId(3),
    ]);

    // Drag "Git Bash 1" onto the left half of the first tab.
    // Testing Library copies these onto a real DataTransfer: `types` is mutated in place.
    const data = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
      types,
      setData: (type: string, value: string) => {
        data.set(type, value);
        if (!types.includes(type)) types.push(type);
      },
      getData: (type: string) => data.get(type) ?? '',
    };
    const source = screen.getByRole('tab', { name: 'Git Bash 1' });
    const target = screen
      .getByRole('tab', { name: 'PowerShell 1' })
      .closest<HTMLElement>('[data-slot="terminal-tab"]');
    if (target === null) throw new Error('no tab wrapper');
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientX: 0 });
    expect(target.getAttribute('data-drop')).toBe('before');
    fireEvent.drop(target, { dataTransfer, clientX: 0 });
    fireEvent.dragEnd(source, { dataTransfer });
    expect(server.sentOfType('move').at(-1)).toEqual({
      type: 'move',
      terminalId: sampleTerminalId(3),
      index: 0,
    });
    await waitFor(() => {
      expect(order()).toEqual(['Git Bash 1', 'PowerShell 1', 'cmd 1']);
    });
  });
});

describe('TerminalPanel (WP-105)', () => {
  it('names a claude terminal "claude 1"; after claude ended "Restart" opens its shell', async () => {
    const claude = sampleTerminalInfo({
      terminalId: sampleTerminalId(1),
      shell: 'powershell',
      command: 'claude',
    });
    const { server } = setup((fake) => {
      fake.items = [claude];
    });
    const user = userEvent.setup();
    await screen.findByRole('tab', { name: 'claude 1' });
    await waitFor(() => {
      expect(server.sentOfType('attach')).toHaveLength(1);
    });
    // While claude runs, the context menu has no "Restart" (it would end claude).
    const screenArea = activeView().querySelector<HTMLElement>('[data-slot="terminal-screen"]');
    if (screenArea === null) throw new Error('no terminal screen');
    fireEvent.contextMenu(screenArea);
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Restart' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Close terminal' })).toBeTruthy();
    await user.keyboard('{Escape}');

    act(() => {
      server.exit(claude.terminalId, 0);
    });
    const bar = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="terminal-exit-bar"]');
      expect(found).not.toBeNull();
      return found;
    });
    expect(bar?.textContent).toContain('claude exited with code 0 – the session continues here');
    await user.click(within(bar ?? document.body).getByRole('button', { name: 'Open PowerShell' }));
    await waitFor(() => {
      expect(server.sentOfType('open')).toHaveLength(1);
    });
    expect(server.sentOfType('close')).toEqual([{ type: 'close', terminalId: claude.terminalId }]);
    expect(server.sentOfType('open')[0]?.shell).toBe('powershell');
    expect(await screen.findByRole('tab', { name: 'PowerShell 1' })).toBeTruthy();
  });

  it('makes a requested terminal active once it is listed, also when it comes later', async () => {
    const { server } = setup((fake) => {
      fake.items = [sampleTerminalInfo({ terminalId: sampleTerminalId(1), shell: 'cmd' })];
    });
    await screen.findByRole('tab', { name: 'cmd 1' });
    await waitFor(() => {
      expect(activeView().getAttribute('data-terminal-id')).toBe(sampleTerminalId(1));
    });

    // "Continue in terminal": the answer (target) may come before the server's list.
    const claude = sampleTerminalInfo({ terminalId: sampleTerminalId(2), shell: 'cmd', command: 'claude' });
    act(() => {
      requestTerminalTarget(TERMINAL_SESSION_KEY, claude.terminalId);
    });
    expect(activeView().getAttribute('data-terminal-id')).toBe(sampleTerminalId(1));
    act(() => {
      server.add(claude);
    });
    const tab = await screen.findByRole('tab', { name: 'claude 1' });
    await waitFor(() => {
      expect(tab.getAttribute('aria-selected')).toBe('true');
    });
    expect(activeView().getAttribute('data-terminal-id')).toBe(claude.terminalId);
  });

  it('names a missing Linux shell instead of the Git for Windows text', async () => {
    setup((fake) => {
      fake.failOpen = makeError('SHELL_NOT_FOUND', { shell: 'zsh' });
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Zsh is not installed on this computer.');
  });

  it('connects to the terminal of another computer through the relay (E3)', async () => {
    const { server } = setup(() => undefined, makeSessionKey(SAMPLE_REMOTE_HOST_ID, SAMPLE_IDS.entry));
    await waitFor(() => {
      expect(server.sockets).toHaveLength(1);
    });
    expect(server.socket.url).toBe(remoteTerminalSocketUrl(SAMPLE_REMOTE_HOST_ID));
    expect(server.socket.url).not.toBe(TERMINAL_SOCKET_URL);
  });
});
