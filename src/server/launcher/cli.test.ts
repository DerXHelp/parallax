import { describe, expect, it } from 'vitest';
import { settingsSchema } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import type { SettingsPeek } from '../config';
import { runLauncherCli, type LauncherCliDeps } from './cli';
import { LauncherError, type LauncherOptions, type LauncherResult } from './launcher';

const HOME = 'D:\\px-cli';
const URI = `parallax://session/${SAMPLE_IDS.entry}`;

interface Harness {
  deps: LauncherCliDeps;
  out: string[];
  err: string[];
  launches: LauncherOptions[];
}

function harness(
  p: { settings?: SettingsPeek; result?: Partial<LauncherResult>; error?: Error } = {},
): Harness {
  const h: Omit<Harness, 'deps'> = { out: [], err: [], launches: [] };
  const deps: LauncherCliDeps = {
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    cwd: 'C:\\repo',
    out: (line) => h.out.push(line),
    fail: (line) => h.err.push(line),
    launch: (options) => {
      h.launches.push(options);
      if (p.error !== undefined) return Promise.reject(p.error);
      return Promise.resolve({
        mode: 'started',
        port: options.port,
        pid: 4242,
        url: null,
        edgePid: options.openWindow === false ? null : 777,
        window: options.openWindow !== false,
        ...p.result,
      });
    },
    readSettings: () => p.settings ?? { settings: null, note: null },
  };
  return Object.assign(h, { deps });
}

const withAutostart = (openWindow: boolean): SettingsPeek => ({
  settings: settingsSchema.parse({ autostart: { enabled: true, openWindow } }),
  note: null,
});

describe('launcher command line flow (cli.ts)', () => {
  it('--open with a valid link: normal start, the window selects the session', async () => {
    const h = harness();
    expect(await runLauncherCli([`--home=${HOME}`, '--open', URI], h.deps)).toBe(0);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]).toMatchObject({ home: HOME, entryId: SAMPLE_IDS.entry, openWindow: true });
    // Case and `//` are optional in the scheme (parseSessionProtocolUri).
    const lax = harness();
    expect(
      await runLauncherCli([`--home=${HOME}`, `--open=PARALLAX:session/${SAMPLE_IDS.entry}/`], lax.deps),
    ).toBe(0);
    expect(lax.launches[0]?.entryId).toBe(SAMPLE_IDS.entry);
  });

  it.each([
    ['another scheme', 'https://example.com/session/x'],
    ['a malformed id', 'parallax://session/en_xyz'],
    ['a path traversal', 'parallax://session/../../x'],
    ['an extra segment', `parallax://session/${SAMPLE_IDS.entry}/more`],
  ])('--open with %s: exit 2, nothing started', async (_name, uri) => {
    const h = harness();
    expect(await runLauncherCli([`--home=${HOME}`, '--open', uri], h.deps)).toBe(2);
    expect(h.launches).toEqual([]);
    expect(h.err.join('\n')).toMatch(/Invalid Parallax link/);
  });

  it('R5: options smuggled after the link: exit 2, nothing started', async () => {
    const h = harness();
    expect(await runLauncherCli(['--open', URI, '--home=C:\\evil'], h.deps)).toBe(2);
    expect(h.launches).toEqual([]);
    expect(h.err.join('\n')).toMatch(/--open must be the last option/);
  });

  it('--autostart: a window only if settings.autostart.openWindow (settings read-only)', async () => {
    const without = harness({ settings: withAutostart(false) });
    expect(await runLauncherCli([`--home=${HOME}`, '--autostart'], without.deps)).toBe(0);
    expect(without.launches[0]).toMatchObject({ openWindow: false, entryId: null, build: true });
    expect(without.out.at(-1)).toMatch(/no window \(autostart\)/);

    const withWindow = harness({ settings: withAutostart(true) });
    expect(await runLauncherCli([`--home=${HOME}`, '--autostart'], withWindow.deps)).toBe(0);
    expect(withWindow.launches[0]).toMatchObject({ openWindow: true });

    // Without (usable) settings the default applies: open a window.
    const defaults = harness();
    expect(await runLauncherCli([`--home=${HOME}`, '--autostart'], defaults.deps)).toBe(0);
    expect(defaults.launches[0]).toMatchObject({ openWindow: true });

    // A normal start ignores autostart.openWindow.
    const normal = harness({ settings: withAutostart(false) });
    expect(await runLauncherCli([`--home=${HOME}`], normal.deps)).toBe(0);
    expect(normal.launches[0]).toMatchObject({ openWindow: true });
  });

  it('prints the notes of loadConfig/settings once; a port from the settings counts as requested', async () => {
    const note =
      'D:\\px-cli\\settings.json ignored (not valid JSON) - using the defaults for port and autostart';
    const h = harness({ settings: { settings: null, note } });
    expect(await runLauncherCli([`--home=${HOME}`], h.deps)).toBe(0);
    expect(h.out.filter((line) => line.includes('ignored'))).toEqual([`Note: ${note}`]);
    expect(h.launches[0]?.portExplicit).toBe(false);
    const ported = harness({ settings: { settings: settingsSchema.parse({ port: 4890 }), note: null } });
    await runLauncherCli([`--home=${HOME}`], ported.deps);
    expect(ported.launches[0]?.portExplicit).toBe(true);
  });

  it('help, bad options, --dev and launcher errors keep their exit codes', async () => {
    const help = harness();
    expect(await runLauncherCli(['--help'], help.deps)).toBe(0);
    expect(help.out.join('\n')).toContain('Usage: parallax');
    const bad = harness();
    expect(await runLauncherCli(['--port=nope'], bad.deps)).toBe(2);
    expect(bad.launches).toEqual([]);
    const dev = harness();
    expect(await runLauncherCli(['--dev'], dev.deps)).toBe(2);
    const failing = harness({ error: new LauncherError('store_too_new', 'newer data') });
    expect(await runLauncherCli([`--home=${HOME}`], failing.deps)).toBe(3);
    expect(failing.err).toEqual(['newer data']);
  });

  it('passes --system-integration on to the server (off under Vitest)', async () => {
    const h = harness();
    await runLauncherCli([`--home=${HOME}`, '--system-integration=auto'], h.deps);
    expect(h.launches[0]?.serverArgs).toContain('--system-integration=off');
    const refused = harness();
    expect(await runLauncherCli([`--home=${HOME}`, '--system-integration=on'], refused.deps)).toBe(2);
    expect(refused.err.join('\n')).toMatch(/not allowed in tests/);
  });
});
