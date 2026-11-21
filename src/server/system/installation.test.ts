import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import type { RunFileFn, RunFileResult } from '../lib/process';
import {
  AUTOSTART_ENV,
  DEFERRED_SHORTCUT,
  FOREIGN_SHORTCUT,
  LAUNCHER_MARKER,
  autostartLinkPath,
  startMenuLinkPath,
} from './autostart';
import { APPDATA_MISSING, ensureStartMenuEntry, removeInstallationEntries } from './installation';
import { PROTOCOL_COMMAND_KEY, PROTOCOL_KEY } from './protocol';
import { FOREIGN_ENTRY, HOME_MISSING, URL_HANDLER_FILE, desktopExecValue, memoryDesktopFs } from './xdg';

/** The Windows suites use a real temp APPDATA with Windows paths (shortcut existence checks). */
const onWindows = process.platform === 'win32';

const ROOT = 'C:\\Users\\u\\AppData\\Local\\Programs\\Parallax';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const INSTALLED = `--use-system-ca --use-env-proxy ${ROOT}\\start.mjs`;
const CLONE = 'D:\\dev\\parallax\\src\\server\\launcher\\main.ts --autostart';
const OTHER = '--use-system-ca --use-env-proxy D:\\Tools\\Parallax\\start.mjs --autostart';

/**
 * A small simulated machine: shortcuts (path → arguments) answered with the script's marker rules,
 * and the protocol handler's command (null = no key) behind reg.exe query/delete.
 */
function machine(protocol: string | null = null) {
  const calls: { tool: 'powershell' | 'reg'; args: readonly string[]; env: Record<string, string> }[] = [];
  const links = new Map<string, string>();
  const state = { protocol };
  const ok = (stdout: string): RunFileResult => ({
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
  });
  const run: RunFileFn = (file, args, options) => {
    const env = options.env ?? {};
    if (file.toLowerCase().endsWith('powershell.exe')) {
      calls.push({ tool: 'powershell', args, env });
      const linkPath = env[AUTOSTART_ENV.path] ?? '';
      const existing = links.get(linkPath)?.toLowerCase();
      const carries = (list: string | undefined) =>
        existing !== undefined &&
        (list ?? '')
          .toLowerCase()
          .split('|')
          .some((marker) => marker !== '' && existing.includes(marker));
      if (existing !== undefined && !carries(env[AUTOSTART_ENV.marker])) {
        return Promise.resolve(ok(carries(env[AUTOSTART_ENV.defer]) ? DEFERRED_SHORTCUT : FOREIGN_SHORTCUT));
      }
      if (env[AUTOSTART_ENV.action] === 'remove') {
        links.delete(linkPath);
        return Promise.resolve(ok('removed'));
      }
      links.set(linkPath, env[AUTOSTART_ENV.args] ?? '');
      return Promise.resolve(ok('created'));
    }
    calls.push({ tool: 'reg', args, env });
    const [verb, key] = args;
    if (verb === 'query') {
      if (state.protocol === null) return Promise.resolve({ ...ok(''), exitCode: 1 });
      const value = key === PROTOCOL_COMMAND_KEY ? state.protocol : '(value not set)';
      return Promise.resolve(ok(`\r\n${key ?? ''}\r\n    (Default)    REG_SZ    ${value}\r\n`));
    }
    if (verb === 'delete' && key === PROTOCOL_KEY) state.protocol = null;
    return Promise.resolve(ok('The operation completed successfully.'));
  };
  return { run, calls, links, state };
}

async function world(protocol: string | null = null) {
  const appData = await makeTempHome('inst-appdata-');
  const env = { APPDATA: appData, SystemRoot: 'C:\\Windows' };
  const autostart = autostartLinkPath(env);
  const startMenu = startMenuLinkPath(env);
  if (autostart === null || startMenu === null) throw new Error('no link paths');
  const m = machine(protocol);
  /** A shortcut on disk (the existence check) with these arguments in the simulation. */
  const place = async (link: string, args: string) => {
    await mkdir(path.dirname(link), { recursive: true });
    await writeFile(link, 'lnk');
    m.links.set(link, args);
  };
  return { m, env, autostart, startMenu, place };
}

describe.runIf(onWindows)('removeInstallationEntries (WP-86, for the uninstaller)', () => {
  it('removes autostart, protocol handler and start menu of exactly this installation', async () => {
    const w = await world(`"${NODE}" ${INSTALLED} --open "%1"`);
    await w.place(w.autostart, `${INSTALLED} --autostart`);
    await w.place(w.startMenu, INSTALLED);
    const removal = await removeInstallationEntries({ installRoot: ROOT, run: w.m.run, env: w.env });
    expect(removal).toEqual({ autostart: { ok: true }, protocol: { ok: true }, startMenu: { ok: true } });
    expect(w.m.links.size).toBe(0);
    expect(w.m.state.protocol).toBeNull();
    // Only the marker of this installation – never launcher\main.ts, nothing deferred.
    expect(
      w.m.calls
        .filter((c) => c.tool === 'powershell')
        .map((c) => [c.env[AUTOSTART_ENV.marker], c.env[AUTOSTART_ENV.defer]]),
    ).toEqual([
      [`${ROOT}\\start.mjs`, undefined],
      [`${ROOT}\\start.mjs`, undefined],
    ]);
  });

  it("leaves a clone's and another installation's entries alone (done, nothing removed)", async () => {
    const clone = `"${NODE}" ${CLONE.replace(' --autostart', '')} --open "%1"`;
    const w = await world(clone);
    await w.place(w.autostart, CLONE);
    await w.place(w.startMenu, OTHER);
    const removal = await removeInstallationEntries({ installRoot: ROOT, run: w.m.run, env: w.env });
    expect(removal).toEqual({ autostart: { ok: true }, protocol: { ok: true }, startMenu: { ok: true } });
    expect(w.m.links.get(w.autostart)).toBe(CLONE);
    expect(w.m.links.get(w.startMenu)).toBe(OTHER);
    expect(w.m.state.protocol).toBe(clone);
    expect(w.m.calls.filter((c) => c.tool === 'reg').map((c) => c.args[0])).toEqual(['query']);
  });

  it('nothing installed: no PowerShell at all, only the registry query', async () => {
    const w = await world();
    const removal = await removeInstallationEntries({ installRoot: ROOT, run: w.m.run, env: w.env });
    expect(removal).toEqual({ autostart: { ok: true }, protocol: { ok: true }, startMenu: { ok: true } });
    expect(w.m.calls.map((c) => `${c.tool} ${c.args[0] ?? ''}`)).toEqual(['reg query']);
  });

  it('without APPDATA the shortcuts are reported, the protocol handler is still removed', async () => {
    const w = await world(`"${NODE}" ${INSTALLED} --open "%1"`);
    const removal = await removeInstallationEntries({
      installRoot: ROOT,
      run: w.m.run,
      env: { SystemRoot: 'C:\\Windows' },
    });
    expect(removal).toEqual({
      autostart: { ok: false, reason: APPDATA_MISSING },
      protocol: { ok: true },
      startMenu: { ok: false, reason: APPDATA_MISSING },
    });
    expect(w.m.state.protocol).toBeNull();
  });
});

describe.runIf(onWindows)(
  'ensureStartMenuEntry (WP-86, installer and every start of the installation)',
  () => {
    it('node.exe <root>\\start.mjs with parallax.ico, never --home; refreshes an own one', async () => {
      const w = await world();
      const node = await realpath(process.execPath);
      expect(await ensureStartMenuEntry({ installRoot: ROOT, run: w.m.run, env: w.env })).toEqual({
        ok: true,
      });
      expect(w.m.calls[0]?.env).toMatchObject({
        [AUTOSTART_ENV.action]: 'create',
        [AUTOSTART_ENV.path]: w.startMenu,
        [AUTOSTART_ENV.target]: node,
        [AUTOSTART_ENV.args]: INSTALLED,
        [AUTOSTART_ENV.cwd]: ROOT,
        [AUTOSTART_ENV.icon]: `${ROOT}\\parallax.ico`,
        [AUTOSTART_ENV.marker]: `${LAUNCHER_MARKER}|${ROOT}\\start.mjs`,
      });
      expect(w.m.links.get(w.startMenu)).toBe(INSTALLED);
      // An old node path is repaired.
      w.m.links.set(w.startMenu, `${INSTALLED} --stale`);
      expect(await ensureStartMenuEntry({ installRoot: ROOT, run: w.m.run, env: w.env })).toEqual({
        ok: true,
      });
      expect(w.m.links.get(w.startMenu)).toBe(INSTALLED);
    });

    it('a foreign start menu shortcut stays (reason foreign); no APPDATA is a reason too', async () => {
      const w = await world();
      w.m.links.set(w.startMenu, 'D:\\dev\\repo\\parallax.cmd');
      expect(await ensureStartMenuEntry({ installRoot: ROOT, run: w.m.run, env: w.env })).toEqual({
        ok: false,
        reason: FOREIGN_SHORTCUT,
      });
      expect(w.m.links.get(w.startMenu)).toBe('D:\\dev\\repo\\parallax.cmd');
      expect(await ensureStartMenuEntry({ installRoot: ROOT, run: w.m.run, env: {} })).toEqual({
        ok: false,
        reason: APPDATA_MISSING,
      });
    });
  },
);

describe('installation entries on Linux (WP-106)', () => {
  const HOME = '/home/demo';
  const LINUX_ROOT = '/home/demo/.local/share/parallax-app';
  const PROGRAM = `${HOME}/.local/share/applications/parallax.desktop`;
  const AUTOSTART = `${HOME}/.config/autostart/parallax.desktop`;
  const HANDLER = `${HOME}/.local/share/applications/${URL_HANDLER_FILE}`;
  const COMMAND = { node: '/usr/bin/node', args: [`${LINUX_ROOT}/start.mjs`], cwd: LINUX_ROOT };
  const entry = (exec: string) => `[Desktop Entry]\nType=Application\nName=Parallax\nExec=${exec}\n`;
  const noRun: RunFileFn = () => Promise.reject(new Error('no program expected'));

  it('ensureStartMenuEntry writes the program entry with <root>/parallax.svg; a foreign one stays', async () => {
    const fs = memoryDesktopFs();
    const env = { HOME };
    expect(
      await ensureStartMenuEntry({
        installRoot: LINUX_ROOT,
        run: noRun,
        env,
        platform: 'linux',
        command: COMMAND,
        desktopFs: fs,
      }),
    ).toEqual({ ok: true });
    const text = fs.files.get(PROGRAM) ?? '';
    expect(desktopExecValue(text)).toBe(`/usr/bin/node ${LINUX_ROOT}/start.mjs`);
    expect(text).toContain(`Icon=${LINUX_ROOT}/parallax.svg`);

    const foreign = memoryDesktopFs({ [PROGRAM]: entry('/usr/bin/other-app') });
    expect(
      await ensureStartMenuEntry({
        installRoot: LINUX_ROOT,
        run: noRun,
        env,
        platform: 'linux',
        command: COMMAND,
        desktopFs: foreign,
      }),
    ).toEqual({ ok: false, reason: FOREIGN_ENTRY });
    expect(foreign.files.get(PROGRAM)).toContain('other-app');
    expect(
      await ensureStartMenuEntry({
        installRoot: LINUX_ROOT,
        run: noRun,
        env: {},
        platform: 'linux',
        desktopFs: fs,
      }),
    ).toEqual({ ok: false, reason: HOME_MISSING });
    expect(
      await ensureStartMenuEntry({
        installRoot: LINUX_ROOT,
        run: noRun,
        env,
        platform: 'darwin',
        desktopFs: fs,
      }),
    ).toEqual({ ok: false, reason: 'unsupported platform' });
  });

  it("removeInstallationEntries removes exactly this installation's entries, never a clone's", async () => {
    const fs = memoryDesktopFs({
      [AUTOSTART]: entry(`/usr/bin/node ${LINUX_ROOT}/start.mjs --autostart`),
      [HANDLER]: entry(`/usr/bin/node ${LINUX_ROOT}/start.mjs --open %u`),
      [PROGRAM]: entry(`/usr/bin/node ${LINUX_ROOT}/start.mjs`),
    });
    const removal = await removeInstallationEntries({
      installRoot: LINUX_ROOT,
      run: noRun,
      env: { HOME },
      platform: 'linux',
      desktopFs: fs,
    });
    expect(removal).toEqual({ autostart: { ok: true }, protocol: { ok: true }, startMenu: { ok: true } });
    expect(fs.files.size).toBe(0);

    const clone = entry('/usr/bin/node /home/demo/dev/parallax/src/server/launcher/main.ts --autostart');
    const other = memoryDesktopFs({
      [AUTOSTART]: clone,
      [PROGRAM]: entry('/usr/bin/node /opt/other/start.mjs'),
    });
    expect(
      await removeInstallationEntries({
        installRoot: LINUX_ROOT,
        run: noRun,
        env: { HOME },
        platform: 'linux',
        desktopFs: other,
      }),
    ).toEqual({ autostart: { ok: true }, protocol: { ok: true }, startMenu: { ok: true } });
    expect(other.files.get(AUTOSTART)).toBe(clone);
    expect(other.files.size).toBe(2);
    expect(
      await removeInstallationEntries({
        installRoot: LINUX_ROOT,
        run: noRun,
        env: {},
        platform: 'linux',
        desktopFs: other,
      }),
    ).toEqual({
      autostart: { ok: false, reason: HOME_MISSING },
      protocol: { ok: true },
      startMenu: { ok: false, reason: HOME_MISSING },
    });
  });
});
