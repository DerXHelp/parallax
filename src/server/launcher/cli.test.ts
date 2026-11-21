import { describe, expect, it } from 'vitest';
import { settingsSchema } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import type { SettingsPeek } from '../config';
import { APPLY_FAILED_PREFIX, APPLY_TIMEOUTS, UPDATE_READY_TIMEOUT_ENV } from '../update/handoff';
import type { ApplyUpdateRequest } from './applyUpdate';
import { makeError } from '@shared/errors';
import type { LauncherRemoteRequest, LauncherRemoteResponse } from '@shared/http';
import {
  remoteLines,
  remoteRefusal,
  runLauncherCli,
  type LauncherCliDeps,
  type RemoteCallResult,
  type ServeOutcome,
  type ServeRequest,
  type ServiceRequest,
} from './cli';
import { LauncherError, type LauncherOptions, type LauncherResult } from './launcher';

const WIN = process.platform === 'win32';
/** WP-107: absolute by the rules of this computer (Linux runs these tests too). */
const HOME = WIN ? 'D:\\px-cli' : '/srv/px-cli';
const APPS = WIN ? 'D:\\apps\\Parallax' : '/opt/Parallax';
const URI = `parallax://session/${SAMPLE_IDS.entry}`;

interface Harness {
  deps: LauncherCliDeps;
  out: string[];
  err: string[];
  launches: LauncherOptions[];
  applies: ApplyUpdateRequest[];
}

function harness(
  p: {
    settings?: SettingsPeek;
    result?: Partial<LauncherResult>;
    error?: Error;
    env?: NodeJS.ProcessEnv;
    applyExit?: number;
  } = {},
): Harness {
  const h: Omit<Harness, 'deps'> = { out: [], err: [], launches: [], applies: [] };
  const deps: LauncherCliDeps = {
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ...p.env },
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
        chromePid: options.openWindow === false ? null : 777,
        window: options.openWindow !== false,
        ...p.result,
      });
    },
    applyUpdate: (request) => {
      h.applies.push(request);
      return Promise.resolve(p.applyExit ?? 0);
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
    expect(lax.launches[0]?.hostId).toBe('local');
  });

  it('WP-81: --open with a session of another computer: the window selects <hostId>:<id>', async () => {
    const h = harness();
    const link = `parallax://session/computer-b/${SAMPLE_IDS.entry}`;
    expect(await runLauncherCli([`--home=${HOME}`, '--open', link], h.deps)).toBe(0);
    expect(h.launches[0]).toMatchObject({
      entryId: SAMPLE_IDS.entry,
      hostId: 'computer-b',
      openWindow: true,
    });
  });

  it.each([
    ['another scheme', 'https://example.com/session/x'],
    ['a malformed id', 'parallax://session/en_xyz'],
    ['a path traversal', 'parallax://session/../../x'],
    ['an extra segment', `parallax://session/computer-b/${SAMPLE_IDS.entry}/more`],
    ['a malformed computer', `parallax://session/Computer_B/${SAMPLE_IDS.entry}`],
    ['"local" as a computer', `parallax://session/local/${SAMPLE_IDS.entry}`],
  ])('--open with %s: exit 2, nothing started', async (_name, uri) => {
    const h = harness();
    expect(await runLauncherCli([`--home=${HOME}`, '--open', uri], h.deps)).toBe(2);
    expect(h.launches).toEqual([]);
    expect(h.err.join('\n')).toMatch(/Invalid Parallax link/);
    // The message names both forms.
    expect(h.err.join('\n')).toContain('parallax://session/<id> or parallax://session/<computer>/<id>');
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

  it('WP-86: passes the install root of a package start on to the server', async () => {
    const plain = harness();
    await runLauncherCli([`--home=${HOME}`], plain.deps);
    expect(plain.launches[0]?.serverArgs.some((arg) => arg.startsWith('--install-root'))).toBe(false);
    const installed = harness();
    await runLauncherCli([`--install-root=${APPS}`, `--home=${HOME}`], installed.deps);
    expect(installed.launches[0]?.installRoot).toBe(APPS);
    expect(installed.launches[0]?.serverArgs).toContain(`--install-root=${APPS}`);
  });

  describe('--apply-update (WP-87b)', () => {
    const ROOT = APPS;
    const APPLY = [`--install-root=${ROOT}`, '--apply-update=1.0.1', '--wait-pid=4242'];

    it('branches off before the launch: the resolved configuration goes to runApplyUpdate', async () => {
      const h = harness({ applyExit: 1 });
      expect(
        await runLauncherCli(
          [...APPLY, '--restore', `--home=${HOME}`, '--port=4800', '--toasts=off'],
          h.deps,
        ),
      ).toBe(1);
      expect(h.launches).toEqual([]);
      expect(h.out).toEqual([]);
      expect(h.applies).toHaveLength(1);
      expect(h.applies[0]).toMatchObject({
        version: '1.0.1',
        restore: true,
        waitPid: 4242,
        installRoot: ROOT,
        home: HOME,
        port: 4800,
        backend: 'sdk',
        readyTimeoutMs: APPLY_TIMEOUTS.readyMs,
        toasts: 'off',
      });
      expect(h.applies[0]?.serverArgs).toEqual(
        expect.arrayContaining([`--home=${HOME}`, '--port=4800', `--install-root=${ROOT}`]),
      );
    });

    it('takes the ready timeout from PARALLAX_UPDATE_READY_TIMEOUT_S', async () => {
      const h = harness({ env: { [UPDATE_READY_TIMEOUT_ENV]: '180' } });
      expect(await runLauncherCli([...APPLY, `--home=${HOME}`], h.deps)).toBe(0);
      expect(h.applies[0]?.readyTimeoutMs).toBe(180_000);
    });

    it('a bad option answers the handshake at once (FAILED spawn) and exits with 2', async () => {
      const missing = harness();
      expect(await runLauncherCli(['--apply-update=1.0.1', '--wait-pid=4242'], missing.deps)).toBe(2);
      expect(missing.out).toEqual([`${APPLY_FAILED_PREFIX} spawn`]);
      expect(missing.err.join('\n')).toMatch(/needs --install-root/);
      const config = harness();
      expect(await runLauncherCli([...APPLY, '--port=nope'], config.deps)).toBe(2);
      expect(config.out).toEqual([`${APPLY_FAILED_PREFIX} spawn`]);
      expect(config.applies).toEqual([]);
      expect(config.launches).toEqual([]);
    });
  });
});

const STATE: NonNullable<LauncherRemoteResponse['remoteAccess']> = {
  listening: true,
  port: 47_200,
  addresses: ['192.0.2.10'],
  hostName: 'demo-server',
  checks: [
    { id: 'port', status: 'ok', params: {} },
    { id: 'keystore', status: 'warning', params: { scheme: 'file' } },
  ],
  peer: {
    name: 'demo-laptop',
    level: 'manage',
    pairedAt: '2026-11-20T10:00:00.000Z',
    connected: true,
    connections: 1,
    lastSeenAt: null,
    lastAddress: null,
    appVersion: null,
    compatible: true,
  },
  pairingExpiresAt: null,
  unseenRejected: 2,
  error: null,
};

describe('WP-107: --server, parallax service, parallax remote', () => {
  function extended(
    p: { serve?: ServeOutcome; remote?: RemoteCallResult; serviceExit?: number } = {},
  ): Harness & {
    serves: ServeRequest[];
    remotes: [string, LauncherRemoteRequest][];
    services: ServiceRequest[];
  } {
    const h = harness();
    const serves: ServeRequest[] = [];
    const remotes: [string, LauncherRemoteRequest][] = [];
    const services: ServiceRequest[] = [];
    h.deps.serve = (request) => {
      serves.push(request);
      request.onStarted({
        mode: 'started',
        port: request.options.port,
        pid: 99,
        url: null,
        chromePid: null,
        window: false,
      });
      return Promise.resolve(p.serve ?? { kind: 'ended', code: 0 });
    };
    h.deps.remote = (home, request) => {
      remotes.push([home, request]);
      return Promise.resolve(
        p.remote ?? { kind: 'ok', response: { remoteAccess: STATE, code: null, expiresAt: null } },
      );
    };
    h.deps.service = (request) => {
      services.push(request);
      return Promise.resolve(p.serviceExit ?? 0);
    };
    return Object.assign(h, { serves, remotes, services });
  }

  it("--server: no window start, the server runs in the foreground; the exit code is the server's", async () => {
    const h = extended({ serve: { kind: 'ended', code: 3 } });
    expect(await runLauncherCli(['--server', `--home=${HOME}`, '--port=4800'], h.deps)).toBe(3);
    expect(h.launches).toEqual([]);
    expect(h.serves[0]?.options).toMatchObject({ home: HOME, port: 4800, printUrl: true, openWindow: false });
    // WP-109: the server of `--server` runs without desktop actions and native toasts.
    expect(h.serves[0]?.options.serverArgs).toContain('--desktop=off');
    expect(h.out.join('\n')).toMatch(/Parallax server runs on http:\/\/127\.0\.0\.1:4800 \(PID 99/);
    // --print-url: the sign-in address (runLauncher prints it), still no Chrome.
    const url = extended();
    expect(await runLauncherCli(['--server', '--print-url', `--home=${HOME}`], url.deps)).toBe(0);
    expect(url.serves[0]?.options).toMatchObject({ printUrl: true, openWindow: true, entryId: null });
  });

  it('--server with a server of this home already running: exit 1, nothing started', async () => {
    const h = extended({ serve: { kind: 'existing', port: 4711, pid: 77 } });
    expect(await runLauncherCli(['--server', `--home=${HOME}`], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(
      /already runs on http:\/\/127\.0\.0\.1:4711 \(PID 77\).*no second server/,
    );
    const unavailable = harness();
    expect(await runLauncherCli(['--server', `--home=${HOME}`], unavailable.deps)).toBe(2);
    const failing = extended();
    failing.deps.serve = () =>
      Promise.reject(new LauncherError('server_exited', 'stopped right after the start'));
    expect(await runLauncherCli(['--server', `--home=${HOME}`], failing.deps)).toBe(1);
    expect(failing.err).toEqual(['stopped right after the start']);
  });

  it('service: the unit gets the resolved home, a requested port and the key-store opt-in', async () => {
    const h = extended({ serviceExit: 0 });
    expect(await runLauncherCli(['service', 'install', `--home=${HOME}`], h.deps)).toBe(0);
    expect(h.services).toEqual([{ action: 'install', serverArgs: [`--home=${HOME}`], installRoot: null }]);
    const more = extended();
    await runLauncherCli(
      [`--install-root=${APPS}`, 'service', 'install', `--home=${HOME}`, '--port=4800', '--backend=fake'],
      more.deps,
    );
    expect(more.services[0]).toEqual({
      action: 'install',
      serverArgs: [`--home=${HOME}`, '--port=4800', '--backend=fake'],
      installRoot: APPS,
    });
    const status = extended({ serviceExit: 3 });
    expect(await runLauncherCli(['service', 'status', `--home=${HOME}`], status.deps)).toBe(3);
    expect(status.launches).toEqual([]);
  });

  it('remote status: the state in words, never a launch', async () => {
    const h = extended();
    expect(await runLauncherCli(['remote', 'status', `--home=${HOME}`], h.deps)).toBe(0);
    expect(h.remotes).toEqual([[HOME, { action: 'status' }]]);
    expect(h.launches).toEqual([]);
    expect(h.out).toEqual([
      'Sharing is on - listening on port 47200.',
      'Computer: demo-server; addresses: 192.0.2.10.',
      'Coupled with demo-laptop (level manage, since 2026-11-20T10:00:00.000Z), connected.',
      'Check keystore: warning.',
      'Rejected attempts since last seen: 2.',
    ]);
  });

  it('remote pair --level manage: the code only on this console, with the level', async () => {
    const h = extended({
      remote: {
        kind: 'ok',
        response: {
          remoteAccess: { ...STATE, peer: null, pairingExpiresAt: '2026-11-21T10:05:00.000Z' },
          code: '1234-5678-9012',
          expiresAt: '2026-11-21T10:05:00.000Z',
        },
      },
    });
    expect(await runLauncherCli(['remote', 'pair', '--level', 'manage', `--home=${HOME}`], h.deps)).toBe(0);
    expect(h.remotes[0]?.[1]).toEqual({ action: 'pair', level: 'manage' });
    expect(h.out[0]).toBe('Pairing code: 1234-5678-9012');
    expect(h.out.join('\n')).toMatch(/Level: manage/);
    expect(h.out.join('\n')).not.toMatch(/A pairing window is open/);
  });

  it('remote: not running, refused, token and transport errors exit 1 with a message', async () => {
    const cases: [RemoteCallResult, RegExp][] = [
      [{ kind: 'not_running' }, /does not run for .* start it first/],
      [{ kind: 'token_invalid' }, /rejected the launcher token/],
      [{ kind: 'failed', reason: 'ETIMEDOUT' }, /No answer from the running server \(ETIMEDOUT\)/],
      [{ kind: 'refused', error: makeError('REMOTE_KEYSTORE_UNAVAILABLE') }, /No key store is usable/],
    ];
    for (const [result, message] of cases) {
      const h = extended({ remote: result });
      expect(await runLauncherCli(['remote', 'unpair', `--home=${HOME}`], h.deps)).toBe(1);
      expect(h.err.join('\n')).toMatch(message);
    }
    expect(remoteRefusal(makeError('VALIDATION_FAILED', { reason: 'not_paired' }))).toBe(
      'No computer is coupled.',
    );
    expect(remoteRefusal(makeError('REMOTE_NOT_ALLOWED'))).toBe('Refused (REMOTE_NOT_ALLOWED).');
  });

  it('remoteLines: sharing off, not listening', () => {
    expect(remoteLines({ action: 'disable' }, { remoteAccess: null, code: null, expiresAt: null })).toEqual([
      'Sharing is off on this computer.',
    ]);
    const lines = remoteLines(
      { action: 'status' },
      {
        remoteAccess: { ...STATE, listening: false, error: makeError('REMOTE_ACCESS_FAILED'), peer: null },
        code: null,
        expiresAt: null,
      },
    );
    expect(lines.slice(0, 3)).toEqual([
      'Sharing is on but not listening (REMOTE_ACCESS_FAILED).',
      'Computer: demo-server; addresses: 192.0.2.10.',
      'Not coupled.',
    ]);
  });
});
