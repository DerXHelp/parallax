import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostCapabilities } from '@shared/model';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { useHostState } from '@web/state/hooks';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { useSettingsEditor } from '../state/settings-editor';
import { ConsoleSection } from './ConsoleSection';
import { FilesSection } from './FilesSection';
import { NotificationsSection } from './NotificationsSection';
import { ServerSection } from './ServerSection';

/** WP-104: the settings sections follow the platform and the capabilities of their computer. */

vi.setConfig({ testTimeout: 60_000 });

const LINUX_DESKTOP: HostCapabilities = {
  desktop: true,
  externalConsole: true,
  shellWindow: true,
  editor: true,
  fileManager: true,
  autostart: true,
  protocolHandler: true,
};

let running: RunningScenario | null = null;

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
});

function Sections({ only }: { only: 'files' | 'console' | 'server' | 'notifications' }) {
  const editor = useSettingsEditor();
  const hostState = useHostState();
  if (hostState === null) return null;
  switch (only) {
    case 'files':
      return <FilesSection editor={editor} hostState={hostState} />;
    case 'console':
      return <ConsoleSection editor={editor} hostState={hostState} />;
    case 'server':
      return <ServerSection editor={editor} hostState={hostState} />;
    case 'notifications':
      return <NotificationsSection editor={editor} hostState={hostState} />;
  }
}

/** The Linux scenario (a server without desktop), optionally with other capabilities. */
async function startLinux(
  only: 'files' | 'console' | 'server' | 'notifications',
  capabilities?: HostCapabilities,
): Promise<RunningScenario> {
  running = startScenario('linux', { select: null });
  const scenario = running;
  if (capabilities !== undefined) scenario.host.setHostState({ ...scenario.host.hostState, capabilities });
  render(
    <TooltipProvider>
      <Sections only={only} />
    </TooltipProvider>,
  );
  await waitFor(() => {
    expect(
      document.querySelector('[data-setting], [data-slot="editor-unavailable"], [role="radio"]'),
    ).not.toBeNull();
  });
  return scenario;
}

async function startWindows(only: 'files' | 'console' | 'server' | 'notifications'): Promise<void> {
  running = startScenario('empty', { select: null });
  render(
    <TooltipProvider>
      <Sections only={only} />
    </TooltipProvider>,
  );
  await waitFor(() => {
    expect(screen.queryAllByRole('radio').length + screen.queryAllByRole('switch').length).toBeGreaterThan(0);
  });
}

describe('settings on a Linux computer (WP-104)', () => {
  it('Files: without a desktop only a note; with one Linux paths, no .exe', async () => {
    await startLinux('files');
    expect(
      screen.getByText('This computer has no desktop: files open in the viewer of Parallax.'),
    ).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('Files on a Linux desktop: the own program takes /usr/bin/…, refuses a Windows path', async () => {
    await startLinux('files', LINUX_DESKTOP);
    const user = userEvent.setup();
    expect(screen.getByRole('radio', { name: 'Default program of the desktop' })).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: /^Own program/ }));
    const path = screen.getByRole('textbox', { name: 'Program' });
    expect(path.getAttribute('placeholder')).toBe('/usr/bin/editor');
    await user.click(screen.getByRole('button', { name: 'Save editor' }));
    await user.clear(path);
    await user.paste('C:\\Tools\\editor.exe');
    expect(screen.getByText('Enter a full path (like /usr/bin/…) – no relative path.')).toBeTruthy();
    await user.clear(path);
    await user.paste('/usr/bin/gedit');
    expect(document.querySelector('[data-slot="editor-issue"][data-issue="path"]')).toBeNull();
  });

  it('Console: the detected Linux shells, the login shell for a Windows default, no Git Bash options', async () => {
    await startLinux('console');
    await waitFor(() => {
      expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual([
        'login',
        'bash',
        'zsh',
      ]);
    });
    expect(screen.getByRole('radio', { name: 'Login shell' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('Git Bash window')).toBeNull();
    expect(screen.queryByText('Folder of Git for Windows (optional)')).toBeNull();
  });

  it('Server: no autostart without one on that computer', async () => {
    await startLinux('server');
    expect(document.querySelector('[data-setting="autostart"]')).toBeNull();
    expect(document.querySelector('[data-setting="openWindow"]')).toBeNull();
    expect(document.querySelector('[data-setting="port"]')).not.toBeNull();
  });

  it('Notifications: no toast column, no system choice and no "click opens" without a desktop', async () => {
    await startLinux('notifications');
    expect(screen.queryByText('Windows notification')).toBeNull();
    expect(screen.queryByText('Desktop notification')).toBeNull();
    expect(document.querySelector('[data-setting="focusedElsewhere"]')).toBeNull();
    expect(document.querySelector('[data-setting="openOnClick"]')).toBeNull();
  });

  it('Notifications on a Linux desktop say "desktop notification"', async () => {
    await startLinux('notifications', LINUX_DESKTOP);
    expect(screen.getByText('Desktop notification')).toBeTruthy();
    expect(screen.getByText('Clicking a desktop notification opens the session')).toBeTruthy();
  });
});

describe('settings on a Windows computer stay as before (WP-104)', () => {
  it('Console offers cmd, PowerShell and Git Bash with the Git Bash options', async () => {
    await startWindows('console');
    expect(
      screen
        .getAllByRole('radio')
        .slice(0, 3)
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['cmd', 'powershell', 'gitbash']);
    expect(screen.getByText('Git Bash window')).toBeTruthy();
  });

  it('Notifications keep "Windows notification" and "click opens"', async () => {
    await startWindows('notifications');
    expect(screen.getByText('Windows notification')).toBeTruthy();
    expect(document.querySelector('[data-setting="openOnClick"]')).not.toBeNull();
  });

  it('Server keeps autostart', async () => {
    await startWindows('server');
    expect(document.querySelector('[data-setting="autostart"]')).not.toBeNull();
  });
});
