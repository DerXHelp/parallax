import { describe, expect, it } from 'vitest';
import { POSIX_PATHS } from '@shared/paths';
import { createMemoryFs } from '../lib/windows';
import { consolePreflight } from './console';
import { createPlatformConsoleLauncher, linuxDesktopCapabilities } from './platform';

const memory = (files: readonly string[]) =>
  createMemoryFs(Object.fromEntries(files.map((file) => [file, ''])), { rules: POSIX_PATHS });

const DESKTOP = { HOME: '/home/demo', PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-0' };

describe('linuxDesktopCapabilities (WP-106, WP-100 §3.3)', () => {
  it('a full desktop: console and shell window, editor, file manager, autostart, parallax: links', async () => {
    const fs = memory(['/usr/bin/ptyxis', '/usr/bin/xdg-open', '/usr/bin/gdbus', '/usr/bin/xdg-mime']);
    expect(await linuxDesktopCapabilities({ env: DESKTOP, fs })).toEqual({
      desktop: true,
      externalConsole: true,
      shellWindow: true,
      editor: true,
      fileManager: true,
      autostart: true,
      protocolHandler: true,
    });
  });

  it('without a graphical session nothing; without the tools only what remains', async () => {
    const fs = memory(['/usr/bin/ptyxis', '/usr/bin/xdg-open', '/usr/bin/gdbus', '/usr/bin/xdg-mime']);
    expect(await linuxDesktopCapabilities({ env: { HOME: '/home/demo', PATH: '/usr/bin' }, fs })).toEqual({
      desktop: false,
      externalConsole: false,
      shellWindow: false,
      editor: false,
      fileManager: false,
      autostart: false,
      protocolHandler: false,
    });
    expect(
      await linuxDesktopCapabilities({
        env: { DISPLAY: ':1', PATH: '/usr/bin' },
        fs: memory(['/usr/bin/gdbus']),
      }),
    ).toEqual({
      desktop: true,
      externalConsole: false,
      shellWindow: false,
      editor: false,
      fileManager: true,
      autostart: false,
      protocolHandler: false,
    });
    // System tools only from /usr/bin and /bin – never from another PATH entry.
    const local = memory(['/home/demo/bin/xdg-open', '/home/demo/bin/xdg-mime']);
    expect(
      await linuxDesktopCapabilities({ env: { ...DESKTOP, PATH: '/home/demo/bin' }, fs: local }),
    ).toMatchObject({
      editor: false,
      protocolHandler: false,
    });
    // A configured emulator counts even when none is on PATH.
    const configured = memory(['/opt/term/myterm']);
    expect(
      await linuxDesktopCapabilities({ env: DESKTOP, fs: configured, terminalEmulator: '/opt/term/myterm' }),
    ).toMatchObject({ externalConsole: true, shellWindow: true });
  });
});

describe('createPlatformConsoleLauncher (WP-106)', () => {
  it('Windows: the PowerShell launcher; Linux with a session: the terminal launcher; otherwise none', () => {
    const windows = createPlatformConsoleLauncher({ platform: 'win32', env: {} });
    expect(windows).not.toBeNull();
    expect(windows === null ? 'none' : consolePreflight(windows)).toBeNull();
    const linux = createPlatformConsoleLauncher({
      platform: 'linux',
      env: DESKTOP,
      terminalEmulator: () => null,
    });
    expect(linux === null ? null : consolePreflight(linux)).toBeTypeOf('function');
    expect(createPlatformConsoleLauncher({ platform: 'linux', env: { HOME: '/home/demo' } })).toBeNull();
    expect(createPlatformConsoleLauncher({ platform: 'darwin', env: DESKTOP })).toBeNull();
  });
});
