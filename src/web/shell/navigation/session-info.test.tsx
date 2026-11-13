import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { Command } from '@shared/protocol';
import { setLanguage } from '@web/i18n';
import { STORAGE_KEYS } from '@web/lib/storage';
import { NAVIGATION_ENTRIES, NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { FAKE_INFO_ACTION_ERROR, FAKE_INFO_FRESH_SKILL, FAKE_MCP } from '@web/state/fake-session-info';
import { resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { requestShell } from '../requests';
import { installShortcutListener } from '../shortcuts';
import { resetRename } from './rename';
import { resetSidebarView } from './sidebar-view';

// The whole shell renders per test (docs/wp/FLAKES.md): generous timeout, conditions instead of waits.
vi.setConfig({ testTimeout: 60_000 });

const KEYS = {
  ...NAVIGATION_SESSION_KEYS,
  release: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.release),
};

let running: RunningScenario | null = null;
const cleanups: (() => void)[] = [];
const originalWidth = window.innerWidth;

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    resetRename();
    resetSidebarView();
    setLanguage('en');
  });
  running?.stop();
  running = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetClientStore();
  window.localStorage.removeItem(STORAGE_KEYS.sessionInfoTab);
  Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true, writable: true });
  window.history.replaceState(null, '', '/');
});

async function start(): Promise<RunningScenario> {
  running = startScenario('navigation');
  cleanups.push(installShortcutListener());
  render(<AppShell />);
  await screen.findByRole('heading', { level: 1 });
  return running;
}

async function openInfo(sessionKey: string = KEYS.auth): Promise<HTMLElement> {
  act(() => {
    requestShell({ kind: 'sessionInfo', sessionKey });
  });
  return screen.findByRole('dialog', { name: 'Session info' });
}

async function openTab(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  await user.click(within(dialog).getByRole('tab', { name }));
  return within(dialog).findByRole('tabpanel');
}

/** The tab's frame once its first answer is there (data-state ≠ loading). */
async function settled(panel: HTMLElement, state = 'ready'): Promise<HTMLElement> {
  return waitFor(() => {
    const frame = panel.querySelector<HTMLElement>('[data-slot="session-info-section"]');
    expect(frame?.getAttribute('data-state')).toBe(state);
    expect(frame?.getAttribute('aria-busy')).toBe('false');
    return frame ?? panel;
  });
}

function infoCommands(host: RunningScenario['host']): Command[] {
  return host.commands.filter((cmd) => cmd.name === 'session.info');
}

describe('session info dialog (WP-67)', () => {
  it('opens on the overview without asking the CLI; every tab asks once when it opens and shows its data', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const dialog = await openInfo();
    expect(within(dialog).getByRole('tab', { name: 'Overview', selected: true })).toBeTruthy();
    expect(within(dialog).getByText('D:\\work\\auth-service')).toBeTruthy();
    expect(infoCommands(scenario.host)).toEqual([]);

    let panel = await openTab(user, dialog, 'MCP');
    await settled(panel);
    for (const name of Object.values(FAKE_MCP)) expect(within(panel).getByText(name)).toBeTruthy();
    expect(within(panel).getByText(/spawn fake-search ENOENT/)).toBeTruthy();
    expect(within(panel).getByText('Sign-in needed')).toBeTruthy();

    panel = await openTab(user, dialog, 'Permissions');
    await settled(panel);
    for (const heading of ['Allow', 'Ask', 'Deny'])
      expect(within(panel).getByRole('heading', { name: new RegExp(heading) })).toBeTruthy();
    expect(within(panel).getByText('Bash(pnpm run test:*)')).toBeTruthy();
    expect(within(panel).getByText('pnpm run test')).toBeTruthy();
    // Grouped by source inside Allow and Ask.
    expect(within(panel).getAllByText('Project settings', { selector: 'h4' })).toHaveLength(2);

    panel = await openTab(user, dialog, 'Skills');
    await settled(panel);
    expect(within(panel).getByRole('table')).toBeTruthy();
    // 420 + 180 + 260 + 95 (the "off" one and the unknown count do not add up).
    expect(within(panel).getByText(/About 955 tokens .* for 4 skills/)).toBeTruthy();
    expect(within(panel).getByText('locked by a managed policy')).toBeTruthy();

    panel = await openTab(user, dialog, 'CLAUDE.md');
    await settled(panel);
    expect(within(panel).getByText('Project memory')).toBeTruthy();
    expect(within(panel).getByText('not created')).toBeTruthy();
    expect(within(panel).getAllByRole('button', { name: 'Copy path' }).length).toBeGreaterThan(2);
    expect(within(panel).getByRole('switch', { name: 'Auto memory' }).hasAttribute('disabled')).toBe(true);

    panel = await openTab(user, dialog, 'Hooks');
    await settled(panel);
    expect(within(panel).getByText('PreToolUse')).toBeTruthy();
    expect(within(panel).getByText('node scripts/check-command.mjs')).toBeTruthy();
    expect(within(panel).getAllByText('every match').length).toBe(2);
    expect(within(panel).getByText('plugin fake-tools')).toBeTruthy();

    panel = await openTab(user, dialog, 'Status');
    await settled(panel);
    expect(within(panel).getByText('Session ID')).toBeTruthy();

    panel = await openTab(user, dialog, 'Export');
    await settled(panel);
    expect(within(panel).getByText(/Fake answer of the web playground/)).toBeTruthy();

    expect(infoCommands(scenario.host).map((cmd) => ('section' in cmd ? cmd.section : null))).toEqual([
      'mcp',
      'permissions',
      'skills',
      'memory',
      'hooks',
      'status',
      'export',
    ]);
  });

  it('remembers the last tab for the next opening (localStorage); broken storage opens the overview', async () => {
    await start();
    const user = userEvent.setup();
    let dialog = await openInfo();
    await settled(await openTab(user, dialog, 'Skills'));
    expect(window.localStorage.getItem(STORAGE_KEYS.sessionInfoTab)).toBe('skills');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Session info' })).toBeNull();
    });
    dialog = await openInfo();
    expect(within(dialog).getByRole('tab', { name: 'Skills', selected: true })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Session info' })).toBeNull();
    });

    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('denied');
    });
    dialog = await openInfo();
    expect(within(dialog).getByRole('tab', { name: 'Overview', selected: true })).toBeTruthy();
  });

  it('MCP: reconnect, turn off after asking, turn on – and a failed action with the CLI text', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const dialog = await openInfo();
    const panel = await openTab(user, dialog, 'MCP');
    await settled(panel);
    const row = (name: string) => {
      const element = panel.querySelector<HTMLElement>(`[data-server="${name}"]`);
      if (element === null) throw new Error(`row ${name} missing`);
      return element;
    };

    await user.click(within(row(FAKE_MCP.search)).getByRole('button', { name: 'Reconnect' }));
    expect(await within(panel).findByText('fake-search reconnected.')).toBeTruthy();
    await waitFor(() => {
      expect(row(FAKE_MCP.search).getAttribute('data-status')).toBe('connected');
    });

    await user.click(within(row(FAKE_MCP.docs)).getByRole('button', { name: 'Turn off' }));
    expect(within(row(FAKE_MCP.docs)).getByText(/Turn off fake-docs\?/)).toBeTruthy();
    expect(
      scenario.host.commands.some((cmd) => cmd.name === 'session.mcpAction' && cmd.action === 'disable'),
    ).toBe(false);
    await user.click(within(row(FAKE_MCP.docs)).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => {
      expect(row(FAKE_MCP.docs).getAttribute('data-status')).toBe('disabled');
    });
    await user.click(within(row(FAKE_MCP.docs)).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => {
      expect(row(FAKE_MCP.docs).getAttribute('data-status')).toBe('connected');
    });

    scenario.host.info.actionError = FAKE_INFO_ACTION_ERROR;
    await user.click(within(row(FAKE_MCP.auth)).getByRole('button', { name: 'Reconnect' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('The action for fake-auth failed');
    expect(alert.textContent).toContain(FAKE_INFO_ACTION_ERROR);
    expect(scenario.host.commands.filter((cmd) => cmd.name === 'session.mcpAction')).toEqual([
      {
        name: 'session.mcpAction',
        entryId: NAVIGATION_ENTRIES.auth,
        server: FAKE_MCP.search,
        action: 'reconnect',
      },
      {
        name: 'session.mcpAction',
        entryId: NAVIGATION_ENTRIES.auth,
        server: FAKE_MCP.docs,
        action: 'disable',
      },
      {
        name: 'session.mcpAction',
        entryId: NAVIGATION_ENTRIES.auth,
        server: FAKE_MCP.docs,
        action: 'enable',
      },
      {
        name: 'session.mcpAction',
        entryId: NAVIGATION_ENTRIES.auth,
        server: FAKE_MCP.auth,
        action: 'reconnect',
      },
    ]);
  });

  it('Skills: reload skills/plugins, then the list again; sorting by tokens', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const dialog = await openInfo();
    const panel = await openTab(user, dialog, 'Skills');
    await settled(panel);
    expect(within(panel).queryByText(FAKE_INFO_FRESH_SKILL)).toBeNull();

    await user.click(within(panel).getByRole('button', { name: 'Reload skills' }));
    expect(await within(panel).findByText('Skills reloaded.')).toBeTruthy();
    expect(await within(panel).findByText(FAKE_INFO_FRESH_SKILL)).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Reload plugins' }));
    expect(await within(panel).findByText('Plugins reloaded.')).toBeTruthy();
    expect(scenario.host.commands.filter((cmd) => cmd.name === 'session.reload')).toEqual([
      { name: 'session.reload', entryId: NAVIGATION_ENTRIES.auth, what: 'skills' },
      { name: 'session.reload', entryId: NAVIGATION_ENTRIES.auth, what: 'plugins' },
    ]);

    const names = () => [...panel.querySelectorAll('tbody tr')].map((row) => row.getAttribute('data-skill'));
    const header = () => within(panel).getByRole('columnheader', { name: /Tokens/ });
    expect(header().getAttribute('aria-sort')).toBe('none');
    await user.click(within(panel).getByRole('button', { name: /Tokens/ }));
    expect(header().getAttribute('aria-sort')).toBe('descending');
    expect(names().slice(0, 2)).toEqual(['review-pr', 'legacy-build']);
    expect(names().at(-1)).toBe('verify');
    await user.click(within(panel).getByRole('button', { name: /Tokens/ }));
    expect(header().getAttribute('aria-sort')).toBe('ascending');
    expect(names()[0]).toBe('docs-lint');
    expect(names().at(-1)).toBe('verify');

    scenario.host.info.actionError = FAKE_INFO_ACTION_ERROR;
    await user.click(within(panel).getByRole('button', { name: 'Reload skills' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('Reloading failed');
    expect(alert.textContent).toContain(FAKE_INFO_ACTION_ERROR);
  });

  it('Permissions: the filter over rule, reading and source', async () => {
    await start();
    const user = userEvent.setup();
    const dialog = await openInfo();
    const panel = await openTab(user, dialog, 'Permissions');
    await settled(panel);
    const filter = within(panel).getByRole('searchbox', { name: 'Filter rules' });
    await user.type(filter, 'git push');
    expect(within(panel).getByText('Bash(git push:*)')).toBeTruthy();
    expect(within(panel).queryByText('Bash(rm -rf:*)')).toBeNull();
    await user.clear(filter);
    await user.type(filter, 'managed policy');
    expect(within(panel).getByText('Read(./secrets/**)')).toBeTruthy();
    expect(within(panel).queryByText('Read')).toBeNull();
    await user.clear(filter);
    await user.type(filter, 'nothing like this');
    expect(within(panel).getByText('No rule matches the filter.')).toBeTruthy();
    expect(within(panel).getByText('D:\\work\\auth-service')).toBeTruthy();
  });

  it('Export: copy and save as a file (browser download with the CLI file name)', async () => {
    await start();
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });

    const dialog = await openInfo();
    const panel = await openTab(user, dialog, 'Export');
    await settled(panel);
    await user.click(within(panel).getByRole('button', { name: 'Copy' }));
    expect(await within(panel).findByText('Conversation copied.')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Fake answer of the web playground'));

    await user.click(within(panel).getByRole('button', { name: 'Save as file' }));
    expect(downloads).toEqual(['2026-11-13-101500-fake-conversation.txt']);
    expect(within(panel).getByText('Saved as 2026-11-13-101500-fake-conversation.txt.')).toBeTruthy();
  });

  it('a section the CLI lacks: "not available with this claude version" (no error)', async () => {
    const scenario = await start();
    scenario.host.info.unavailable = new Set(['hooks']);
    const user = userEvent.setup();
    const dialog = await openInfo();
    const panel = await openTab(user, dialog, 'Hooks');
    await settled(panel, 'unavailable');
    expect(within(panel).getByText('Not available with this claude version.')).toBeTruthy();
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('a sleeping session: "not running – start?" starts it without a prompt and asks again', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const dialog = await openInfo(KEYS.release);
    const panel = await openTab(user, dialog, 'Status');
    await settled(panel, 'notRunning');
    expect(within(panel).getByText('The session is not running.')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Start session' }));
    await settled(panel);
    expect(within(panel).getByText('Session ID')).toBeTruthy();
    expect(scenario.host.commands).toContainEqual({
      name: 'session.resume',
      entryId: NAVIGATION_ENTRIES.release,
    });
    expect(scenario.host.commands.some((cmd) => cmd.name === 'session.sendPrompt')).toBe(false);
  });

  it('errors show in the tab (no toast); a failed refresh keeps the data; external and archived sessions are refused', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    scenario.host.failNext(
      'session.info',
      makeError('CLAUDE_CONTROL_FAILED', { method: 'readInfo', section: 'status' }),
    );
    let dialog = await openInfo();
    let panel = await openTab(user, dialog, 'Status');
    await settled(panel, 'failed');
    expect(within(panel).getByRole('alert').textContent).toContain('This section could not be loaded');
    expect(within(screen.getByRole('region', { name: 'Notifications' })).queryByText(/could not/)).toBeNull();

    await user.click(within(panel).getByRole('button', { name: 'Refresh' }));
    await settled(panel);
    scenario.host.failNext(
      'session.info',
      makeError('CLAUDE_CONTROL_FAILED', { method: 'readInfo', section: 'status' }),
    );
    await user.click(within(panel).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(within(panel).getByRole('alert')).toBeTruthy();
    });
    expect(within(panel).getByText('Session ID')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Session info' })).toBeNull();
    });

    dialog = await openInfo(KEYS.external);
    panel = await within(dialog).findByRole('tabpanel');
    await settled(panel, 'failed');
    expect(within(panel).getByRole('alert').textContent).toMatch(/open in another console/i);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Session info' })).toBeNull();
    });

    dialog = await openInfo(KEYS.prototype);
    panel = await within(dialog).findByRole('tabpanel');
    await settled(panel, 'failed');
    expect(within(panel).getByRole('alert').textContent).toMatch(/archived/i);
  });

  it('a narrow window shows a select instead of the tab row; German texts come with the dialog', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true, writable: true });
    await start();
    const user = userEvent.setup();
    const dialog = await openInfo();
    expect(within(dialog).queryByRole('tablist')).toBeNull();
    const select = within(dialog).getByRole('combobox', { name: 'Section' });
    select.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: 'Skills' }));
    const region = await within(dialog).findByRole('region', { name: 'Skills' });
    await settled(region);
    expect(within(region).getByRole('table')).toBeTruthy();
    act(() => {
      setLanguage('de');
    });
    expect(within(region).getByRole('button', { name: 'Skills neu laden' })).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: 'Bereich' })).toBeTruthy();
  });
});
