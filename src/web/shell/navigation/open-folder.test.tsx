import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import { SAMPLE_IDS, sampleFileInfo, sampleSummary } from '@shared/samples';
import { NAVIGATION_ENTRIES, NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { installShortcutListener } from '../shortcuts';
import { resetRename } from './rename';
import { HEADER_ACTIONS, openFolderInExplorer, SIDEBAR_ACTIONS, sessionActions } from './session-actions';
import { resetSidebarView } from './sidebar-view';

vi.setConfig({ testTimeout: 60_000 });

const AUTH_CWD = 'D:\\work\\auth-service';

let running: RunningScenario | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  act(() => {
    resetRename();
    resetSidebarView();
  });
  running?.stop();
  running = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetClientStore();
  window.history.replaceState(null, '', '/');
});

async function start(): Promise<RunningScenario> {
  running = startScenario('navigation');
  cleanups.push(installShortcutListener());
  render(<AppShell />);
  await screen.findByRole('heading', { level: 1 });
  return running;
}

async function chooseOpenFolder(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Session actions' }));
  const menu = await screen.findByRole('menu');
  await user.click(within(menu).getByRole('menuitem', { name: 'Open folder in Explorer' }));
}

describe('"Open folder in Explorer" (WP-58, ADR-144)', () => {
  it('only the local host offers it – after "Open in new window" in both menus', () => {
    const summary = sampleSummary();
    const local = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
    const remote = makeSessionKey('pc-2', SAMPLE_IDS.entry);
    for (const slots of [HEADER_ACTIONS, SIDEBAR_ACTIONS]) {
      const ids = sessionActions(slots, local, summary, 'header').map((action) => action?.id ?? null);
      expect(ids.indexOf('openFolder')).toBe(ids.indexOf('openWindow') + 1);
      const remoteIds = sessionActions(slots, remote, summary, 'header').map((action) => action?.id ?? null);
      expect(remoteIds).not.toContain('openFolder');
    }
  });

  it('sends file.open {target: explorer} with the cwd exactly as stored', async () => {
    const scenario = await start();
    // The folder exists on the fake host.
    scenario.host.setFile({ info: sampleFileInfo({ path: AUTH_CWD, kind: 'directory' }), text: null });
    const user = userEvent.setup();
    await chooseOpenFolder(user);
    await waitFor(() => {
      expect(scenario.host.fileOpens).toEqual([
        {
          name: 'file.open',
          entryId: NAVIGATION_ENTRIES.auth,
          path: AUTH_CWD,
          target: 'explorer',
          line: null,
          col: null,
        },
      ]);
    });
    expect(screen.queryByText('The program could not be started.')).toBeNull();
  });

  it('a refusal becomes a notice of the session (OPEN_FAILED, FILE_NOT_FOUND)', async () => {
    const scenario = await start();
    scenario.host.setFile({ info: sampleFileInfo({ path: AUTH_CWD, kind: 'directory' }), text: null });
    scenario.host.fileOpenError = makeError('OPEN_FAILED');
    const user = userEvent.setup();
    await chooseOpenFolder(user);
    expect(await screen.findByText('The program could not be started.')).toBeTruthy();

    // A folder that is gone: the fake file service answers FILE_NOT_FOUND.
    scenario.host.files.clear();
    scenario.host.fileOpenError = null;
    await chooseOpenFolder(user);
    expect(await screen.findByText('The file does not exist (any more).')).toBeTruthy();
  });

  it('PATH_NOT_ALLOWED from the server becomes a notice of the session (R5W-11)', async () => {
    const scenario = await start();
    scenario.host.setFile({ info: sampleFileInfo({ path: AUTH_CWD, kind: 'directory' }), text: null });
    scenario.host.fileOpenError = makeError('PATH_NOT_ALLOWED');
    const user = userEvent.setup();
    await chooseOpenFolder(user);
    expect(await screen.findByText('Access to this path is not allowed.')).toBeTruthy();
    expect(scenario.host.fileOpens.map((cmd) => cmd.path)).toEqual([AUTH_CWD]);
  });

  it('a cwd the path rules reject is never sent – the notice says so (R5W-10, C.10)', async () => {
    const scenario = await start();
    act(() => {
      openFolderInExplorer(
        NAVIGATION_SESSION_KEYS.auth,
        sampleSummary({ entryId: NAVIGATION_ENTRIES.auth, cwd: '\\\\server\\share\\auth' }),
      );
    });
    expect(await screen.findByText(/This path cannot be used/)).toBeTruthy();
    // Not even sent (the fake server would refuse it with the same text, see fake-host.ts).
    expect(scenario.host.commands.filter((cmd) => cmd.name === 'file.open')).toEqual([]);
  });

  it('the sidebar context menu of a row offers it, too', async () => {
    const scenario = await start();
    scenario.host.setFile({ info: sampleFileInfo({ path: AUTH_CWD, kind: 'directory' }), text: null });
    const user = userEvent.setup();
    const row = document.querySelector<HTMLElement>(`[data-session-row="${NAVIGATION_SESSION_KEYS.auth}"]`);
    if (row === null) throw new Error('row missing');
    await user.pointer({ keys: '[MouseRight]', target: row });
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Open folder in Explorer' }));
    await waitFor(() => {
      expect(scenario.host.fileOpens.map((cmd) => cmd.path)).toEqual([AUTH_CWD]);
    });
  });
});
