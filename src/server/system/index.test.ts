import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { settingsSchema, type Settings } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import type { RunFileFn, RunFileOptions } from '../lib/process';
import { AUTOSTART_ENV, autostartLinkPath, type StartCommand } from './autostart';
import { AUTOSTART_WARNING_ID, PROTOCOL_WARNING_ID, createSystemIntegration } from './index';
import { PROTOCOL_COMMAND_KEY, PROTOCOL_KEY } from './protocol';

const REPO = 'D:\\dev\\parallax';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

const settings = (autostart: boolean, openOnClick: boolean): Settings =>
  settingsSchema.parse({
    autostart: { enabled: autostart, openWindow: true },
    notifications: { openOnClick },
  });

interface Call {
  tool: 'powershell' | 'reg';
  args: readonly string[];
  env: Record<string, string>;
}

/**
 * A simulated machine: PowerShell answers the shortcut script, reg.exe works on an in-memory
 * HKCU (`<key>|<value name>`; a key exists while it or a subkey has a value, and like reg.exe a
 * `/ve` query of an existing key without a default value answers "(value not set)").
 * `failShortcut`/`failReg` make the tools fail, `failQuery` the reg.exe queries; `inFlight`
 * checks that nothing overlaps.
 */
function machine(
  p: {
    failShortcut?: boolean;
    failReg?: boolean;
    failQuery?: 'timeout' | 'spawn' | 'exit';
    hkcu?: Record<string, string>;
  } = {},
) {
  const calls: Call[] = [];
  const hkcu = new Map(Object.entries(p.hkcu ?? {}));
  let inFlight = 0;
  let maxInFlight = 0;
  const run: RunFileFn = async (file, args, options: RunFileOptions) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    const env = options.env ?? {};
    const ok = (stdout: string) => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false });
    const fail = (stderr: string) => ({ exitCode: 1, signal: null, stdout: '', stderr, timedOut: false });
    if (file.toLowerCase().endsWith('powershell.exe')) {
      calls.push({ tool: 'powershell', args, env });
      if (p.failShortcut === true) return { ...ok('error: Zugriff verweigert'), exitCode: 3 };
      return ok(env[AUTOSTART_ENV.action] === 'remove' ? 'removed' : 'created');
    }
    calls.push({ tool: 'reg', args, env });
    const [verb, key] = args;
    if (verb === 'query') {
      if (p.failQuery === 'timeout') {
        return { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true };
      }
      if (p.failQuery === 'spawn') throw new Error('spawn EPERM');
      if (p.failQuery === 'exit') return { ...fail('ERROR: out of memory'), exitCode: 5 };
      const value = hkcu.get(`${key ?? ''}|`);
      if (value !== undefined) return ok(`\r\n${key ?? ''}\r\n    (Default)    REG_SZ    ${value}\r\n`);
      const prefix = (key ?? '').toLowerCase();
      const exists = [...hkcu.keys()].some(
        (k) => k.toLowerCase().startsWith(`${prefix}\\`) || k.toLowerCase().startsWith(`${prefix}|`),
      );
      return exists
        ? ok(`\r\n${key ?? ''}\r\n    (Default)    REG_SZ    (value not set)\r\n`)
        : fail('ERROR: not found');
    }
    if (p.failReg === true) return fail('ERROR: Access is denied.');
    if (verb === 'add') {
      const name = args[2] === '/ve' ? '' : (args[3] ?? '');
      const data = args[args.indexOf('/d') + 1] ?? '';
      hkcu.set(`${key ?? ''}|${name}`, data);
    }
    if (verb === 'delete') {
      for (const k of [...hkcu.keys()])
        if (k.toLowerCase().startsWith((key ?? '').toLowerCase())) hkcu.delete(k);
    }
    return ok('The operation completed successfully.');
  };
  return {
    run,
    calls,
    hkcu,
    maxInFlight: () => maxInFlight,
  };
}

async function world(p: Parameters<typeof machine>[0] & { home?: 'default' | 'other' } = {}) {
  const appData = await makeTempHome('sys-appdata-');
  const localAppData = await makeTempHome('sys-local-');
  const env = { APPDATA: appData, LOCALAPPDATA: localAppData, SystemRoot: 'C:\\Windows' };
  const home = p.home === 'other' ? 'D:\\px-live' : path.join(localAppData, 'Parallax');
  const m = machine(p);
  const command = (extra: readonly string[], homeArg: string | null): Promise<StartCommand> =>
    Promise.resolve({
      node: NODE,
      args: [
        `${REPO}\\src\\server\\launcher\\main.ts`,
        ...(homeArg === null ? [] : [`--home=${homeArg}`]),
        ...extra,
      ],
      cwd: REPO,
    });
  const link = autostartLinkPath(env);
  if (link === null) throw new Error('no link');
  return { m, env, link, home, command, now: () => new Date('2026-10-16T08:00:00.000Z') };
}

describe('createSystemIntegration (ADR-109, ADR-110)', () => {
  it('available: false → nothing happens, no launch URI, no warnings', async () => {
    const w = await world();
    const integration = createSystemIntegration({
      available: false,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: w.env,
      platform: 'win32',
    });
    await integration.apply(settings(true, true));
    expect(w.m.calls).toEqual([]);
    expect(integration.toastLaunchUri(SAMPLE_IDS.entry)).toBeNull();
    expect(integration.warnings()).toEqual([]);
    expect(integration.available).toBe(false);
  });

  it('on: creates the shortcut and registers the handler; the toast gets the launch URI', async () => {
    const w = await world();
    const integration = createSystemIntegration({
      available: true,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: w.env,
      platform: 'win32',
      command: w.command,
    });
    let changes = 0;
    integration.onChange(() => (changes += 1));
    await integration.apply(settings(true, true));
    const shortcut = w.m.calls.find((c) => c.tool === 'powershell');
    expect(shortcut?.env).toMatchObject({
      [AUTOSTART_ENV.action]: 'create',
      [AUTOSTART_ENV.path]: w.link,
      [AUTOSTART_ENV.target]: NODE,
      [AUTOSTART_ENV.args]: `${REPO}\\src\\server\\launcher\\main.ts --autostart`,
      [AUTOSTART_ENV.cwd]: REPO,
    });
    // Default data directory: no --home in the commands.
    expect(w.m.hkcu.get(`${PROTOCOL_COMMAND_KEY}|`)).toBe(
      `"${NODE}" ${REPO}\\src\\server\\launcher\\main.ts --open "%1"`,
    );
    expect(w.m.hkcu.get(`${PROTOCOL_KEY}|`)).toBe('URL:Parallax');
    expect(w.m.hkcu.get(`${PROTOCOL_KEY}|URL Protocol`)).toBe('');
    expect(integration.toastLaunchUri(SAMPLE_IDS.entry)).toBe(`parallax://session/${SAMPLE_IDS.entry}`);
    expect(integration.warnings()).toEqual([]);
    expect(changes).toBe(1);
    // The same settings again: nothing to do (no PowerShell per unrelated setting).
    const before = w.m.calls.length;
    await integration.apply(settings(true, true));
    expect(w.m.calls).toHaveLength(before);
    expect(changes).toBe(1);
  });

  it('another data directory (--system-integration=on): the commands carry --home', async () => {
    const w = await world({ home: 'other' });
    const integration = createSystemIntegration({
      available: true,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: w.env,
      platform: 'win32',
      command: w.command,
    });
    await integration.apply(settings(true, true));
    expect(w.m.calls.find((c) => c.tool === 'powershell')?.env[AUTOSTART_ENV.args]).toBe(
      `${REPO}\\src\\server\\launcher\\main.ts --home=D:\\px-live --autostart`,
    );
    expect(w.m.hkcu.get(`${PROTOCOL_COMMAND_KEY}|`)).toContain('--home=D:\\px-live --open "%1"');
  });

  it('off: removes an existing shortcut and the own handler; the launch URI is gone', async () => {
    const w = await world();
    await mkdir(path.dirname(w.link), { recursive: true });
    await writeFile(w.link, 'lnk');
    const own = `"${NODE}" ${REPO}\\src\\server\\launcher\\main.ts --open "%1"`;
    w.m.hkcu.set(`${PROTOCOL_COMMAND_KEY}|`, own);
    const integration = createSystemIntegration({
      available: true,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: w.env,
      platform: 'win32',
      command: w.command,
    });
    await integration.apply(settings(false, false));
    expect(w.m.calls.find((c) => c.tool === 'powershell')?.env[AUTOSTART_ENV.action]).toBe('remove');
    expect(w.m.calls.filter((c) => c.tool === 'reg').map((c) => c.args[0])).toEqual(['query', 'delete']);
    expect(w.m.hkcu.size).toBe(0);
    expect(integration.toastLaunchUri(SAMPLE_IDS.entry)).toBeNull();
  });

  it('off with nothing installed: no PowerShell at all (only the registry query)', async () => {
    const w = await world();
    const integration = createSystemIntegration({
      available: true,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: w.env,
      platform: 'win32',
      command: w.command,
    });
    await integration.apply(settings(false, false));
    expect(w.m.calls.map((c) => `${c.tool} ${c.args[0] ?? ''}`)).toEqual(['reg query']);
  });

  it('failures become host warnings (ids system:autostart / system:protocol), never a throw', async () => {
    const w = await world({ failShortcut: true, failReg: true });
    const integration = createSystemIntegration({
      available: true,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: w.env,
      platform: 'win32',
      command: w.command,
      now: w.now,
    });
    let changes = 0;
    integration.onChange(() => (changes += 1));
    await integration.apply(settings(true, true));
    expect(integration.warnings()).toEqual([
      {
        id: AUTOSTART_WARNING_ID,
        error: { code: 'AUTOSTART_FAILED', params: { reason: 'exit 3: error: Zugriff verweigert' } },
        at: '2026-10-16T08:00:00.000Z',
      },
      {
        id: PROTOCOL_WARNING_ID,
        error: {
          code: 'PROTOCOL_HANDLER_FAILED',
          params: { reason: 'reg.exe exit 1: ERROR: Access is denied.' },
        },
        at: '2026-10-16T08:00:00.000Z',
      },
    ]);
    expect(integration.toastLaunchUri(SAMPLE_IDS.entry)).toBeNull();
    expect(changes).toBe(1);
    // A failed state is tried again on the next apply; the same failure is no new change.
    await integration.apply(settings(true, true));
    expect(changes).toBe(1);
    // Switched off: the warnings go away.
    await integration.apply(settings(false, false));
    expect(integration.warnings()).toEqual([]);
    expect(changes).toBe(2);
  });

  it('a foreign parallax handler is never overwritten (PROTOCOL_HANDLER_FAILED foreign)', async () => {
    const foreign = '"C:\\Program Files\\Other\\other.exe" "%1"';
    const w = await world({ hkcu: { [`${PROTOCOL_COMMAND_KEY}|`]: foreign } });
    const integration = createSystemIntegration({
      available: true,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: w.env,
      platform: 'win32',
      command: w.command,
    });
    await integration.apply(settings(false, true));
    expect(integration.warnings().map((x) => x.error)).toEqual([
      { code: 'PROTOCOL_HANDLER_FAILED', params: { reason: 'foreign' } },
    ]);
    expect(w.m.hkcu.get(`${PROTOCOL_COMMAND_KEY}|`)).toBe(foreign);
    expect(integration.toastLaunchUri(SAMPLE_IDS.entry)).toBeNull();
  });

  it.each(['timeout', 'spawn', 'exit'] as const)(
    'CR2-01: a failed registry query (%s) is no free key – nothing is written, a warning instead',
    async (failQuery) => {
      const w = await world({ failQuery });
      const integration = createSystemIntegration({
        available: true,
        repoRoot: REPO,
        home: w.home,
        run: w.m.run,
        env: w.env,
        platform: 'win32',
        command: w.command,
      });
      await integration.apply(settings(false, true));
      expect(w.m.calls.filter((c) => c.tool === 'reg').map((c) => c.args[0])).not.toContain('add');
      expect(integration.warnings().map((x) => x.error.code)).toEqual(['PROTOCOL_HANDLER_FAILED']);
      expect(integration.toastLaunchUri(SAMPLE_IDS.entry)).toBeNull();
    },
  );

  it('CR2-01: an existing parallax key without a recognizable own command is foreign (never overwritten)', async () => {
    // E.g. a handler of another program with only the scheme key, or a verb other than shell\open.
    const hkcu = {
      [`${PROTOCOL_KEY}|`]: 'URL:Other App',
      [`${PROTOCOL_KEY}|URL Protocol`]: '',
      [`${PROTOCOL_KEY}\\shell\\view\\command|`]: '"C:\\Other\\app.exe" "%1"',
    };
    const w = await world({ hkcu });
    const integration = createSystemIntegration({
      available: true,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: w.env,
      platform: 'win32',
      command: w.command,
    });
    await integration.apply(settings(false, true));
    expect(integration.warnings().map((x) => x.error)).toEqual([
      { code: 'PROTOCOL_HANDLER_FAILED', params: { reason: 'foreign' } },
    ]);
    expect(Object.fromEntries(w.m.hkcu)).toEqual(hkcu);
    // Switching it off leaves the foreign key alone as well.
    await integration.apply(settings(false, false));
    expect(Object.fromEntries(w.m.hkcu)).toEqual(hkcu);
    expect(w.m.calls.filter((c) => c.tool === 'reg').map((c) => c.args[0])).not.toContain('delete');
  });

  it('applies run one after another, never in parallel', async () => {
    const w = await world();
    const integration = createSystemIntegration({
      available: true,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: w.env,
      platform: 'win32',
      command: w.command,
    });
    await Promise.all([
      integration.apply(settings(true, true)),
      integration.apply(settings(false, false)),
      integration.apply(settings(true, false)),
    ]);
    expect(w.m.maxInFlight()).toBe(1);
    // The last apply wins.
    expect(integration.toastLaunchUri(SAMPLE_IDS.entry)).toBeNull();
    expect(w.m.hkcu.has(`${PROTOCOL_COMMAND_KEY}|`)).toBe(false);
  });

  it('missing APPDATA and other platforms are warnings, not errors', async () => {
    const w = await world();
    const integration = createSystemIntegration({
      available: true,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: { SystemRoot: 'C:\\Windows' },
      platform: 'win32',
      command: w.command,
    });
    await integration.apply(settings(true, false));
    expect(integration.warnings().map((x) => x.error.params.reason)).toEqual(['APPDATA is not set']);
    const linux = createSystemIntegration({
      available: true,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: w.env,
      platform: 'linux',
      command: w.command,
    });
    await linux.apply(settings(true, true));
    expect(linux.warnings().map((x) => x.error.params.reason)).toEqual(['not Windows', 'not Windows']);
  });

  it('onChange can be unsubscribed; a throwing listener does not break apply', async () => {
    const w = await world({ failReg: true });
    const integration = createSystemIntegration({
      available: true,
      repoRoot: REPO,
      home: w.home,
      run: w.m.run,
      env: w.env,
      platform: 'win32',
      command: w.command,
    });
    let calls = 0;
    const off = integration.onChange(() => (calls += 1));
    integration.onChange(() => {
      throw new Error('listener');
    });
    off();
    await expect(integration.apply(settings(false, true))).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });
});
