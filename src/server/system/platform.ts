/**
 * The desktop of this host for the composition (WP-106, WP-100 §3.3/§5.5): which console launcher
 * the engine gets and which desktop actions a Linux host offers (`HostCapabilities`). The
 * coordinator wires both into `lib/platform.ts` / `app/compose.ts`.
 *
 * - `createPlatformConsoleLauncher`: Windows → the PowerShell launcher (system/console.ts); Linux with
 *   a graphical session → the terminal-emulator launcher (system/linuxConsole.ts, the emulator of the
 *   setting at the time of the click); otherwise null – `session.openExternal` then answers
 *   EXTERNAL_CONSOLE_FAILED {reason: 'unavailable'} before anything changed (sessions/external.ts).
 * - `linuxDesktopCapabilities`: without a graphical session (`DISPLAY`/`WAYLAND_DISPLAY`) nothing;
 *   with one: console and shell window if a terminal emulator is found (or one is configured),
 *   editor/default program if `xdg-open` exists, "show in folder" with `gdbus` or `xdg-open`,
 *   autostart with a known HOME, `parallax:` with `xdg-mime`. Server mode (WP-107) stays the
 *   coordinator's (it switches `desktop` off before). Lookups only through the given `FsProbe`
 *   (absolute `/usr/bin/<tool>`, the PATH for emulators); never throws, never hangs.
 */
import type { HostCapabilities } from '@shared/model';
import { POSIX_SYSTEM_TOOL_DIRS, searchPosixPath } from '../lib/executables';
import { hasGraphicalSession } from '../lib/platform';
import { nodeFsProbe, type FsProbe } from '../lib/windows';
import { createConsoleLauncher } from './console';
import { createLinuxConsoleLauncher } from './linuxConsole';
import type { ConsoleLauncher } from './ports';
import { resolveTerminalEmulator } from './terminalEmulator';
import { autostartEntryPath, urlHandlerEntryPath } from './xdg';

export interface PlatformConsoleOptions {
  platform?: NodeJS.Platform;
  /** Environment of the server (graphical session, PATH; default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Linux: `settings().console.terminalEmulator` at the time of the click. */
  terminalEmulator?: () => string | null;
}

/** The console launcher of this host, or null where none can open a window (see the file comment). */
export function createPlatformConsoleLauncher(opts: PlatformConsoleOptions = {}): ConsoleLauncher | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === 'win32') return createConsoleLauncher();
  if (platform === 'linux' && hasGraphicalSession(env)) {
    return createLinuxConsoleLauncher({
      env,
      ...(opts.terminalEmulator === undefined ? {} : { terminalEmulator: opts.terminalEmulator }),
    });
  }
  return null;
}

export interface LinuxDesktopProbe {
  /** Environment of the server (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** File lookups (default the guarded real file system). */
  fs?: FsProbe;
  /** `console.terminalEmulator` of the settings (null = detect). */
  terminalEmulator?: string | null;
}

const SYSTEM_TOOL_PATH = POSIX_SYSTEM_TOOL_DIRS.join(':');

const NOTHING: HostCapabilities = {
  desktop: false,
  externalConsole: false,
  shellWindow: false,
  editor: false,
  fileManager: false,
  autostart: false,
  protocolHandler: false,
};

/** The desktop actions of a Linux host (see the file comment). */
export async function linuxDesktopCapabilities(probe: LinuxDesktopProbe = {}): Promise<HostCapabilities> {
  const env = probe.env ?? process.env;
  const fs = probe.fs ?? nodeFsProbe;
  if (!hasGraphicalSession(env)) return { ...NOTHING };
  const tool = async (name: string): Promise<boolean> => {
    try {
      // The directories of `systemTool` (lib/executables.ts), never the PATH.
      const [hit] = await searchPosixPath(name, { PATH: SYSTEM_TOOL_PATH }, fs);
      return hit !== undefined;
    } catch {
      return false;
    }
  };
  const [terminal, xdgOpen, gdbus, xdgMime] = await Promise.all([
    resolveTerminalEmulator({ configured: probe.terminalEmulator ?? null, env, fs }).catch(() => null),
    tool('xdg-open'),
    tool('gdbus'),
    tool('xdg-mime'),
  ]);
  return {
    desktop: true,
    externalConsole: terminal !== null,
    shellWindow: terminal !== null,
    editor: xdgOpen,
    fileManager: gdbus || xdgOpen,
    autostart: autostartEntryPath(env) !== null,
    protocolHandler: xdgMime && urlHandlerEntryPath(env) !== null,
  };
}
