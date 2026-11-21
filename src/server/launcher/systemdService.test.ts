import { describe, expect, it } from 'vitest';
import {
  SYSTEMD_UNIT_NAME,
  installService,
  quoteEnvironmentValue,
  quoteUnitValue,
  serviceStatus,
  systemdUnit,
  systemdUnitPath,
  uninstallService,
  unitPathValue,
  type ServiceDeps,
  type ToolResult,
} from './systemdService';

const UNIT = '/home/demo/.config/systemd/user/parallax.service';

interface World {
  deps: ServiceDeps;
  out: string[];
  calls: string[][];
  files: Map<string, string>;
  removed: string[];
}

function world(
  p: {
    platform?: NodeJS.Platform;
    answers?: Record<string, Partial<ToolResult>>;
    files?: Record<string, string>;
    /** False: no systemctl on this computer. */
    systemctl?: boolean;
  } = {},
): World {
  const w: Omit<World, 'deps'> = {
    out: [],
    calls: [],
    files: new Map(Object.entries(p.files ?? {})),
    removed: [],
  };
  const deps: ServiceDeps = {
    platform: p.platform ?? 'linux',
    env: {},
    homeDir: '/home/demo',
    userName: 'demo',
    isExecutable: () => p.systemctl !== false,
    out: (line) => w.out.push(line),
    run: (file, args) => {
      w.calls.push([file.split('/').pop() ?? file, ...args]);
      const key = args.join(' ');
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', ...p.answers?.[key] });
    },
    writeFile: (file, text) => {
      w.files.set(file, text);
      return Promise.resolve();
    },
    readFile: (file) => {
      const text = w.files.get(file);
      if (text !== undefined) return Promise.resolve(text);
      return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    },
    removeFile: (file) => {
      w.removed.push(file);
      w.files.delete(file);
      return Promise.resolve();
    },
  };
  return Object.assign(w, { deps });
}

const OPTIONS = {
  command: ['/usr/bin/node', '/opt/parallax/start.mjs'],
  serverArgs: ['--home=/home/demo/.local/share/parallax'],
  workDir: '/opt/parallax',
  path: '/home/demo/.local/bin:/usr/bin',
};

describe('systemd user service (WP-107)', () => {
  it('the unit lives under XDG_CONFIG_HOME, else ~/.config', () => {
    expect(systemdUnitPath({}, '/home/demo')).toBe(UNIT);
    expect(systemdUnitPath({ XDG_CONFIG_HOME: '/srv/cfg' }, '/home/demo')).toBe(
      '/srv/cfg/systemd/user/parallax.service',
    );
    // A relative XDG_CONFIG_HOME is invalid by the spec: the default applies.
    expect(systemdUnitPath({ XDG_CONFIG_HOME: 'cfg' }, '/home/demo')).toBe(UNIT);
  });

  it('quotes values by systemd rules; a line break is refused', () => {
    expect(quoteUnitValue('/opt/my app/start.mjs')).toBe('"/opt/my app/start.mjs"');
    expect(quoteUnitValue('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(quoteUnitValue('50%')).toBe('"50%%"');
    expect(quoteUnitValue('$HOME')).toBe('"$$HOME"');
    expect(() => quoteUnitValue('a\nExecStartPre=/bin/evil')).toThrow(/line break/);
    // Review WP-109: Environment= expands no variables; WorkingDirectory= takes no quotes at all.
    expect(quoteEnvironmentValue('PATH=/a$b:/c%d')).toBe('"PATH=/a$b:/c%%d"');
    expect(unitPathValue('/opt/my app 50%')).toBe('/opt/my app 50%%');
    expect(() => unitPathValue('relative/dir')).toThrow(/absolute/);
    expect(() => unitPathValue('/opt/x\n[Service]')).toThrow(/line break/);
  });

  it('the unit starts the launcher with --server in the foreground (Type=simple)', () => {
    const text = systemdUnit(OPTIONS);
    expect(text).toContain(
      'ExecStart="/usr/bin/node" "/opt/parallax/start.mjs" "--server" "--home=/home/demo/.local/share/parallax"',
    );
    expect(text).toContain('Type=simple');
    expect(text.split('\n')).toContain('WorkingDirectory=/opt/parallax');
    expect(text).toContain('Environment="PATH=/home/demo/.local/bin:/usr/bin"');
    expect(text).toContain('WantedBy=default.target');
    expect(systemdUnit({ ...OPTIONS, path: '' })).not.toContain('Environment=');
    // Review WP-109: SIGTERM only to the launcher (it passes it on); a user manager has no network-online.target.
    expect(text.split('\n')).toContain('KillMode=mixed');
    expect(text).not.toContain('network-online');
  });

  it('install: writes the unit, reloads, enable --now, and hints at lingering', async () => {
    const w = world({ answers: { [`show-user demo --property=Linger --value`]: { stdout: 'no\n' } } });
    expect(await installService(OPTIONS, w.deps)).toBe(0);
    expect(w.files.get(UNIT)).toContain('"--server"');
    expect(w.calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
      ['loginctl', 'show-user', 'demo', '--property=Linger', '--value'],
    ]);
    expect(w.out.join('\n')).toMatch(/sudo loginctl enable-linger demo/);
    const linger = world({ answers: { [`show-user demo --property=Linger --value`]: { stdout: 'yes\n' } } });
    await installService(OPTIONS, linger.deps);
    expect(linger.out.join('\n')).toMatch(/Lingering is on/);
  });

  it('install: a failing systemctl ends with exit 1 and its message; Windows is refused', async () => {
    const w = world({
      answers: {
        [`--user enable --now ${SYSTEMD_UNIT_NAME}`]: { exitCode: 1, stderr: 'Failed to connect to bus\n' },
      },
    });
    expect(await installService(OPTIONS, w.deps)).toBe(1);
    expect(w.out.join('\n')).toMatch(/enable --now parallax.service failed: Failed to connect to bus/);
    const win = world({ platform: 'win32' });
    expect(await installService(OPTIONS, win.deps)).toBe(2);
    expect(win.calls).toEqual([]);
    expect(win.files.size).toBe(0);
    // Review WP-109: without systemctl nothing is written, the message says why.
    const bare = world({ systemctl: false });
    expect(await installService(OPTIONS, bare.deps)).toBe(2);
    expect(bare.out.join('\n')).toMatch(/systemctl was not found/);
    expect(bare.calls).toEqual([]);
    expect(bare.files.size).toBe(0);
  });

  it('uninstall: disable --now, the unit removed, reloaded; the data folder untouched', async () => {
    const w = world({ files: { [UNIT]: 'x' } });
    expect(await uninstallService(w.deps)).toBe(0);
    expect(w.calls).toEqual([
      ['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT_NAME],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    expect(w.removed).toEqual([UNIT]);
  });

  it('status: not installed → 3; active → 0 with enabled state', async () => {
    const none = world();
    expect(await serviceStatus(none.deps)).toBe(3);
    expect(none.out.join('\n')).toMatch(/not installed/);
    const w = world({
      files: { [UNIT]: 'x' },
      answers: {
        [`--user is-enabled ${SYSTEMD_UNIT_NAME}`]: { stdout: 'enabled\n' },
        [`--user is-active ${SYSTEMD_UNIT_NAME}`]: { stdout: 'active\n' },
      },
    });
    expect(await serviceStatus(w.deps)).toBe(0);
    expect(w.out[0]).toBe(`Service ${SYSTEMD_UNIT_NAME}: active, enabled (${UNIT}).`);
    const stopped = world({
      files: { [UNIT]: 'x' },
      answers: { [`--user is-active ${SYSTEMD_UNIT_NAME}`]: { exitCode: 3, stdout: 'inactive\n' } },
    });
    expect(await serviceStatus(stopped.deps)).toBe(3);
  });
});
