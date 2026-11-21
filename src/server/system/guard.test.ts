/**
 * R6 guard (WP-30 §9): no test touches the real HKCU (`Software\Classes\parallax`), the real
 * autostart folder (`%APPDATA%`) or opens a console. Without an injected `run`/`env` the Windows
 * integration refuses in a test run before anything is spawned – checked here with a
 * `child_process.spawn` that fails the test if it is ever reached – and every test that builds an
 * integration injects its runner (static check below). WP-106: the same for Linux – no `.desktop`
 * entry under the real HOME, no `xdg-mime`, no terminal emulator, no `xdg-open`/`gdbus`.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as ChildProcess from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { settingsSchema } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import { spawnHidden } from '../lib/process';
import { createConsoleLauncher } from './console';
import { showInFileManager, xdgOpen } from './desktop';
import { createSystemIntegration } from './index';
import { APPDATA_MISSING, ensureStartMenuEntry, removeInstallationEntries } from './installation';
import { NO_TERMINAL_EMULATOR, createLinuxConsoleLauncher } from './linuxConsole';
import { createPlatformConsoleLauncher } from './platform';
import { TEST_RUN_REFUSAL, isTestProcess, systemEnv, systemRunner, systemSpawner } from './run';
import { HOME_MISSING } from './xdg';

const spawned = vi.hoisted(() => [] as string[]);

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcess>();
  return {
    ...original,
    spawn: (file: string) => {
      spawned.push(file);
      throw new Error(`guard test: spawn of ${file} must not happen`);
    },
  };
});

const SPEC = {
  executablePath: 'C:\\Users\\u\\.local\\bin\\claude.exe',
  args: ['--resume', 'x'],
  env: {},
  explicitEnv: {},
  cwd: 'C:\\',
};

describe('R6: the Windows integration never runs for real in a test run', () => {
  it('this is a test run; the defaults are refused, the environment is empty', async () => {
    expect(isTestProcess()).toBe(true);
    expect(isTestProcess({ NODE_ENV: 'test' })).toBe(true);
    // R4-14: one rule with config.ts – under Vitest also a hand-made env counts as a test run.
    expect(isTestProcess({})).toBe(true);
    expect(systemEnv()).toEqual({});
    const env = { APPDATA: 'C:\\temp' };
    expect(systemEnv(env)).toBe(env);
    await expect(systemRunner()('C:\\Windows\\System32\\reg.exe', [], { timeoutMs: 1 })).rejects.toThrow(
      TEST_RUN_REFUSAL,
    );
    expect(spawned).toEqual([]);
  });

  it('console without an injected run: failed, nothing spawned', async () => {
    const launcher = createConsoleLauncher({ platform: 'win32' });
    const result = await launcher.open(SPEC);
    expect(result).toEqual({
      kind: 'failed',
      reason: `powershell could not be started: ${TEST_RUN_REFUSAL}`,
    });
    // The state query reads the process list in this process (ADR-229): it starts nothing either.
    await launcher.state({ pid: process.pid, startedAt: new Date() });
    expect(spawned).toEqual([]);
  });

  it('autostart + protocol handler without run/env: warnings only, no HKCU, no shortcut', async () => {
    const integration = createSystemIntegration({
      available: true,
      repoRoot: 'D:\\dev\\parallax',
      home: 'D:\\px',
      platform: 'win32',
    });
    await integration.apply(
      settingsSchema.parse({
        autostart: { enabled: true, openWindow: true },
        notifications: { openOnClick: true },
      }),
    );
    expect(integration.warnings().map((w) => [w.id, w.error.params.reason])).toEqual([
      ['system:autostart', 'APPDATA is not set'],
      // CR2-01: already the query is refused – a failed query never leads to a write.
      ['system:protocol', `registry query: reg.exe could not be started: ${TEST_RUN_REFUSAL}`],
    ]);
    expect(integration.toastLaunchUri(SAMPLE_IDS.entry)).toBeNull();
    expect(spawned).toEqual([]);
  });

  it('WP-86: installation entries (start menu, uninstaller) without run/env: refused, nothing spawned', async () => {
    const installRoot = 'C:\\Programs\\Parallax';
    const integration = createSystemIntegration({
      available: true,
      repoRoot: 'D:\\dev\\parallax',
      installRoot,
      home: 'D:\\px',
      platform: 'win32',
    });
    await integration.apply(
      settingsSchema.parse({
        autostart: { enabled: false, openWindow: true },
        notifications: { openOnClick: false },
      }),
    );
    expect(await ensureStartMenuEntry({ installRoot, platform: 'win32' })).toEqual({
      ok: false,
      reason: APPDATA_MISSING,
    });
    // With a temp APPDATA but no runner the PowerShell is refused before it starts (a Windows path:
    // the shortcut folder is created first). test/setup points PARALLAX_HOME at a temp folder.
    if (process.platform === 'win32') {
      const appData = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'guard-appdata-'));
      expect(await ensureStartMenuEntry({ installRoot, env: { APPDATA: appData } })).toEqual({
        ok: false,
        reason: `powershell could not be started: ${TEST_RUN_REFUSAL}`,
      });
    }
    expect(await removeInstallationEntries({ installRoot, platform: 'win32' })).toEqual({
      autostart: { ok: false, reason: APPDATA_MISSING },
      protocol: { ok: false, reason: `registry query: reg.exe could not be started: ${TEST_RUN_REFUSAL}` },
      startMenu: { ok: false, reason: APPDATA_MISSING },
    });
    expect(spawned).toEqual([]);
  });

  it('WP-106 Linux: entries, console and desktop programs without seams – refused, nothing spawned', async () => {
    const integration = createSystemIntegration({
      available: true,
      repoRoot: '/home/demo/dev/parallax',
      installRoot: '/home/demo/.local/share/parallax-app',
      home: '/home/demo/px',
      platform: 'linux',
    });
    await integration.apply(
      settingsSchema.parse({
        autostart: { enabled: true, openWindow: true },
        notifications: { openOnClick: true },
      }),
    );
    // The test run's environment is empty: no HOME, so no `.desktop` path and no xdg-mime.
    expect(integration.warnings().map((w) => [w.id, w.error.params.reason])).toEqual([
      ['system:autostart', HOME_MISSING],
      ['system:protocol', HOME_MISSING],
    ]);
    const installRoot = '/home/demo/.local/share/parallax-app';
    expect(await ensureStartMenuEntry({ installRoot, platform: 'linux' })).toEqual({
      ok: false,
      reason: HOME_MISSING,
    });
    expect(await removeInstallationEntries({ installRoot, platform: 'linux' })).toEqual({
      autostart: { ok: false, reason: HOME_MISSING },
      protocol: { ok: true },
      startMenu: { ok: false, reason: HOME_MISSING },
    });

    const spec = { ...SPEC, executablePath: '/home/demo/.local/bin/claude', cwd: '/home/demo/work' };
    // No environment → no PATH → no terminal emulator.
    expect(await createLinuxConsoleLauncher().open(spec)).toEqual({
      kind: 'failed',
      reason: NO_TERMINAL_EMULATOR,
    });
    // An emulator found, but no injected spawn: refused before anything starts.
    const launcher = createLinuxConsoleLauncher({
      terminalEmulator: () => '/usr/bin/xterm',
      fs: { isFile: () => Promise.resolve(true), readText: () => Promise.resolve(null) },
    });
    expect(await launcher.open(spec)).toEqual({
      kind: 'failed',
      reason: `terminal emulator could not be started: ${TEST_RUN_REFUSAL}`,
    });
    expect(() => systemSpawner()('/usr/bin/xterm', [], {})).toThrow(TEST_RUN_REFUSAL);
    // Without a graphical session there is no Linux console at all.
    expect(createPlatformConsoleLauncher({ platform: 'linux', env: {} })).toBeNull();
    expect(createPlatformConsoleLauncher({ platform: 'darwin', env: { DISPLAY: ':0' } })).toBeNull();

    const tool = (name: string) => `/usr/bin/${name}`;
    await expect(xdgOpen('/home/demo/work/a.txt', { tool })).rejects.toMatchObject({
      error: { code: 'OPEN_FAILED' },
    });
    await expect(showInFileManager('/home/demo/work/a.txt', false, { tool })).rejects.toMatchObject({
      error: { code: 'OPEN_FAILED' },
    });
    expect(spawned).toEqual([]);
  });

  it('every server test that builds an integration injects its runner; none reads the real APPDATA', async () => {
    const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const self = fileURLToPath(import.meta.url);
    const files = (await readdir(serverDir, { recursive: true }))
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => path.join(serverDir, file))
      .filter((file) => file !== self);
    const factories =
      /\b(createSystemIntegration|createConsoleLauncher|createAutostartShortcut|removeAutostartShortcut|createStartMenuShortcut|removeStartMenuShortcut|ensureStartMenuEntry|removeInstallationEntries)\(/;
    // WP-106: the Linux console needs an injected spawn, the `.desktop` entries a memory file system.
    const spawners = /\b(createLinuxConsoleLauncher|xdgOpen|showInFileManager)\(/;
    const desktopFiles =
      /\b(createAutostartEntry|removeAutostartEntry|ensureProgramEntry|removeProgramEntry|registerUrlHandler|unregisterUrlHandler|writeDesktopEntry|removeDesktopEntry)\(/;
    const offenders: string[] = [];
    // Read at once, not one after another: under a full parallel `pnpm check` (virus scanner) each
    // read can take long – the sequential loop once hit the 20-s test timeout (FIX-R4-F1).
    const texts = await Promise.all(
      files.map(async (file) => ({ file, text: await readFile(file, 'utf8') })),
    );
    for (const { file, text } of texts) {
      if (/process\.env\.APPDATA|process\.env\['APPDATA'\]/.test(text))
        offenders.push(`${file}: real APPDATA`);
      if (factories.test(text) && !/\brun\b/.test(text)) offenders.push(`${file}: no injected run`);
      if (spawners.test(text) && !/\bspawn\b/.test(text)) offenders.push(`${file}: no injected spawn`);
      if (desktopFiles.test(text) && !/\bmemoryDesktopFs\b/.test(text))
        offenders.push(`${file}: no memory desktop files`);
    }
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(10);
  });

  it('(self-check) the spawn trap of this file is active', () => {
    expect(() => spawnHidden(process.execPath, ['--version'])).toThrow(/guard test/);
    expect(spawned).toEqual([process.execPath]);
    spawned.length = 0;
  });
});
