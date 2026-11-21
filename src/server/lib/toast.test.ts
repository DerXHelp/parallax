import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { RunFileFn, RunFileOptions, RunFileResult } from './process';
import {
  TOAST_APP_ID,
  TOAST_GROUP,
  TOAST_SCRIPT,
  createLinuxNotifier,
  encodePowerShell,
  gvariantString,
  hasNotificationSession,
  notifySendArgs,
  parseNotificationId,
  removeToast,
  showToast,
  toastTemplateXml,
  type ToastSpawnFn,
  type ToastWaiter,
} from './toast';

interface Call {
  file: string;
  args: readonly string[];
  options: RunFileOptions;
}

function fakeRun(stdout = 'shown', exitCode = 0): { run: RunFileFn; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunFileFn = (file, args, options) => {
    calls.push({ file, args, options });
    return Promise.resolve({ exitCode, signal: null, stdout: `${stdout}\r\n`, stderr: '', timedOut: false });
  };
  return { run, calls };
}

const ENV = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows', PARALLAX_TOAST_TITLE: 'inherited' };

describe('native Windows toast helper (WP22-03/-15, A.9)', () => {
  it('runs the constant script as -EncodedCommand; data only in the environment (no injection)', async () => {
    const { run, calls } = fakeRun();
    const evil = `"; Remove-Item C:\\ -Recurse; $(calc) <text>&amp;</text> \u0007`;
    expect(
      await showToast({ title: evil, body: 'body', tag: 'en_1' }, { run, platform: 'win32', env: ENV }),
    ).toEqual({
      kind: 'shown',
    });
    const call = calls[0];
    if (call === undefined) throw new Error('no call');
    expect(call.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(call.args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShell(TOAST_SCRIPT),
    ]);
    // The user text is nowhere in the command line …
    expect(call.args.join(' ')).not.toContain('Remove-Item');
    // … but in the environment, control characters replaced; the inherited value is overridden.
    expect(call.options.env).toMatchObject({
      PARALLAX_TOAST_ACTION: 'show',
      PARALLAX_TOAST_TITLE: evil.replace('\u0007', ' '),
      PARALLAX_TOAST_BODY: 'body',
      PARALLAX_TOAST_TAG: 'en_1',
      PARALLAX_TOAST_GROUP: TOAST_GROUP,
      PARALLAX_TOAST_APP_ID: TOAST_APP_ID,
      PARALLAX_TOAST_APP_NAME: 'Parallax',
      PATH: 'C:\\Windows',
    });
    // The script builds the XML with DOM calls and registers only the display name in HKCU.
    expect(TOAST_SCRIPT).toContain('CreateTextNode($env:PARALLAX_TOAST_TITLE)');
    expect(TOAST_SCRIPT).toContain("'HKCU:\\Software\\Classes\\AppUserModelId\\'");
    expect(TOAST_SCRIPT).not.toMatch(/HKLM|Policies/i);
    expect(Buffer.from(encodePowerShell('a'), 'base64').toString('utf16le')).toBe('a');
  });

  it('caps text and tag; remove uses tag + group', async () => {
    const { run, calls } = fakeRun('removed');
    expect(await removeToast('x'.repeat(100), { run, platform: 'win32', env: ENV })).toEqual({
      kind: 'removed',
    });
    expect(calls[0]?.options.env?.PARALLAX_TOAST_TAG).toHaveLength(64);
    expect(calls[0]?.options.env?.PARALLAX_TOAST_ACTION).toBe('remove');
    const show = fakeRun();
    await showToast(
      { title: 't'.repeat(1000), body: '', tag: 't' },
      { run: show.run, platform: 'win32', env: ENV },
    );
    expect(show.calls[0]?.options.env?.PARALLAX_TOAST_TITLE).toHaveLength(300);
  });

  const spawnError = (code: string): Error => Object.assign(new Error(`spawn ${code}`), { code });

  it.each<[string, RunFileFn, RegExp, boolean]>([
    [
      'CLM/AppLocker (setup, exit 4)',
      fakeRun('error[setup]: language mode ConstrainedLanguage', 4).run,
      /exit 4: error\[setup\]: language mode/,
      true,
    ],
    [
      'WinRT types missing (setup, exit 4)',
      fakeRun('error[setup]: Unable to find type [Windows.UI.Notifications.ToastNotificationManager].', 4)
        .run,
      /exit 4: error\[setup\]: Unable to find type/,
      true,
    ],
    [
      'Show failed (exit 3)',
      fakeRun('error[show]: Element not found.', 3).run,
      /exit 3: error\[show\]/,
      false,
    ],
    ['an unexpected answer', fakeRun('something').run, /exit 0: something/, false],
    [
      'a timeout',
      () => Promise.resolve({ exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }),
      /timeout/,
      false,
    ],
    [
      'PowerShell missing',
      () => Promise.reject(spawnError('ENOENT')),
      /could not be started: spawn ENOENT/,
      true,
    ],
    [
      'no handles left (EMFILE)',
      () => Promise.reject(spawnError('EMFILE')),
      /could not be started: spawn EMFILE/,
      false,
    ],
  ])('%s → failed, never thrown; permanent as classified (CR-05)', async (_name, run, reason, permanent) => {
    const result = await showToast({ title: 't', body: 'b', tag: 'x' }, { run, platform: 'win32', env: ENV });
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.reason).toMatch(reason);
    expect(result.permanent).toBe(permanent);
  });

  it('CR-05: the script checks the language mode first and tells the setup from the action', () => {
    const lines = TOAST_SCRIPT.split('\n');
    const mode = lines.findIndex((l) => l.includes('$ExecutionContext.SessionState.LanguageMode'));
    const registry = lines.findIndex((l) => l.includes('HKCU:'));
    expect(mode).toBeGreaterThan(0);
    expect(mode).toBeLessThan(registry);
    expect(TOAST_SCRIPT).toContain('$step = $env:PARALLAX_TOAST_ACTION');
    expect(TOAST_SCRIPT).toContain("if ($step -eq 'setup') { exit 4 }");
  });

  it('Phase 2: launchUri → activationType="protocol" + launch (by DOM), silent → <audio silent>', async () => {
    const entryId = 'en_0123456789abcdef0123456789abcdef';
    const { run, calls } = fakeRun();
    await showToast(
      { title: 't', body: 'b', tag: 'x', launchUri: `PARALLAX:session/${entryId}/`, silent: true },
      { run, platform: 'win32', env: ENV },
    );
    const env = calls[0]?.options.env ?? {};
    // The canonical URI (re-generated from the parsed id) goes into the environment …
    expect(env.PARALLAX_TOAST_LAUNCH).toBe(`parallax://session/${entryId}`);
    // … the skeleton carries only booleans.
    expect(env.PARALLAX_TOAST_XML).toBe(toastTemplateXml({ launch: true, silent: true }));
    expect(toastTemplateXml({ launch: true, silent: true })).toBe(
      '<toast activationType="protocol" launch=""><visual><binding template="ToastGeneric"><text></text>' +
        '<text></text></binding></visual><audio silent="true"/></toast>',
    );
    expect(TOAST_SCRIPT).toContain("$xml.DocumentElement.SetAttribute('launch', $env:PARALLAX_TOAST_LAUNCH)");
    expect(TOAST_SCRIPT).toContain('$xml.LoadXml($env:PARALLAX_TOAST_XML)');
  });

  it('WP-81: the form with a computer goes into the toast, canonical', async () => {
    const entryId = 'en_0123456789abcdef0123456789abcdef';
    const { run, calls } = fakeRun();
    await showToast(
      { title: 't', body: 'b', tag: 'x', launchUri: `Parallax:session/computer-b/${entryId}/` },
      { run, platform: 'win32', env: ENV },
    );
    expect(calls[0]?.options.env?.PARALLAX_TOAST_LAUNCH).toBe(`parallax://session/computer-b/${entryId}`);
  });

  it.each([
    ['no launchUri', undefined],
    ['null', null],
    ['another scheme', 'https://evil.example/session/x'],
    ['a malformed id', 'parallax://session/en_1"/><x'],
    ['a malformed computer', 'parallax://session/Computer B/en_0123456789abcdef0123456789abcdef'],
    ['"local" as a computer', 'parallax://session/local/en_0123456789abcdef0123456789abcdef'],
  ])(
    'without a valid launchUri (%s): plain toast as in Phase 1, no launch variable',
    async (_name, launchUri) => {
      const { run, calls } = fakeRun();
      await showToast({ title: 't', body: 'b', tag: 'x', launchUri }, { run, platform: 'win32', env: ENV });
      const env = calls[0]?.options.env ?? {};
      expect(env.PARALLAX_TOAST_LAUNCH).toBeUndefined();
      expect(env.PARALLAX_TOAST_XML).toBe(
        '<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>',
      );
    },
  );

  it('an inherited PARALLAX_TOAST_LAUNCH never reaches the script', async () => {
    const { run, calls } = fakeRun();
    await showToast(
      { title: 't', body: 'b', tag: 'x' },
      { run, platform: 'win32', env: { ...ENV, PARALLAX_TOAST_LAUNCH: 'parallax://session/x' } },
    );
    expect(calls[0]?.options.env?.PARALLAX_TOAST_LAUNCH).toBeUndefined();
    expect(toastTemplateXml({ launch: false, silent: true })).toContain('<audio silent="true"/>');
  });

  it('other platforms: failed without a call', async () => {
    const { run, calls } = fakeRun();
    expect(await showToast({ title: 't', body: 'b', tag: 'x' }, { run, platform: 'darwin' })).toEqual({
      kind: 'failed',
      reason: 'unsupported platform',
      permanent: true,
    });
    expect(calls).toEqual([]);
  });
});

// ---- Linux (WP-106) ----

const DESKTOP = {
  PATH: '/usr/bin',
  DISPLAY: ':0',
  XDG_RUNTIME_DIR: '/run/user/1000',
  CLAUDECODE: '1',
  PARALLAX_ENTRY_ID: 'en_x',
};
const tool = (name: string) => `/usr/bin/${name}`;
const ENTRY_URI = 'parallax://session/en_00000000000000000000000000000001';

/** Answers per program: notify-send and gdbus results (or a start error). */
function linuxRun(
  answers: { notify?: Partial<RunFileResult> | Error; gdbus?: Partial<RunFileResult> | Error } = {},
) {
  const calls: { file: string; args: readonly string[]; env: Record<string, string> | undefined }[] = [];
  const run: RunFileFn = (file, args, options) => {
    calls.push({ file, args, env: options.env });
    const answer = file.endsWith('/notify-send') ? answers.notify : answers.gdbus;
    if (answer instanceof Error) return Promise.reject(answer);
    const stdout = file.endsWith('/notify-send') ? '17\n' : '(uint32 23,)\n';
    return Promise.resolve({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, ...answer });
  };
  return { run, calls };
}

/** Waiting notify-send processes: `print(line)` writes to stdout, `exit(code)` ends one. */
function linuxSpawn(options: { error?: Error } = {}) {
  const started: { file: string; args: readonly string[]; stdio: unknown }[] = [];
  const children: {
    out: PassThrough;
    killed: string[];
    print: (line: string) => void;
    exit: (code: number) => void;
  }[] = [];
  const spawn: ToastSpawnFn = (file, args, spawnOptions) => {
    started.push({ file, args, stdio: spawnOptions.stdio });
    const out = new PassThrough();
    const killed: string[] = [];
    const emitter = new EventEmitter();
    const child: ToastWaiter = Object.assign(emitter, {
      stdout: out,
      kill: (signal?: NodeJS.Signals) => {
        killed.push(signal ?? 'SIGTERM');
        return true;
      },
      unref: () => undefined,
    });
    children.push({
      out,
      killed,
      print: (line) => out.write(`${line}\n`),
      exit: (code) => emitter.emit('exit', code),
    });
    queueMicrotask(() => {
      if (options.error === undefined) emitter.emit('spawn');
      else emitter.emit('error', options.error);
    });
    return child;
  };
  return { spawn, started, children };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('Linux toasts over the notification server (WP-106, WP-100 §5.7)', () => {
  it('helpers: session check, GVariant strings, notification ids, notify-send arguments', () => {
    expect(hasNotificationSession(DESKTOP)).toBe(true);
    expect(
      hasNotificationSession({
        WAYLAND_DISPLAY: 'wayland-0',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      }),
    ).toBe(true);
    expect(hasNotificationSession({ XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(false);
    expect(hasNotificationSession({ DISPLAY: ':0' })).toBe(false);
    expect(gvariantString("it's a\\b\nc")).toBe(String.raw`'it\'s a\\b\nc'`);
    expect(parseNotificationId('17\n')).toBe(17);
    expect(parseNotificationId('(uint32 23,)\n')).toBe(23);
    expect(parseNotificationId('default')).toBeNull();
    expect(parseNotificationId('0')).toBeNull();
    expect(notifySendArgs({ title: '-t', body: 'b', silent: true, replaceId: 9 }, 'Open')).toEqual([
      '--app-name=Parallax',
      '--print-id',
      '--hint=string:desktop-entry:parallax',
      '--hint=boolean:suppress-sound:true',
      '--replace-id=9',
      '--action=default=Open',
      '--wait',
      '--',
      '-t',
      'b',
    ]);
  });

  it('without a click: one notify-send; the same tag replaces, remove closes it over gdbus', async () => {
    const { run, calls } = linuxRun();
    const notifier = createLinuxNotifier({ env: DESKTOP, run, tool, spawn: linuxSpawn().spawn });
    expect(
      await showToast({ title: 'A – done', body: 'Body', tag: 'en_1' }, { platform: 'linux', notifier }),
    ).toEqual({
      kind: 'shown',
    });
    expect(calls[0]?.file).toBe('/usr/bin/notify-send');
    expect(calls[0]?.args.slice(-3)).toEqual(['--', 'A – done', 'Body']);
    // The environment of a desktop program: no Claude session variables, no PARALLAX*.
    expect(calls[0]?.env).toEqual({ PATH: '/usr/bin', DISPLAY: ':0', XDG_RUNTIME_DIR: '/run/user/1000' });
    await notifier.show({ title: 'A – error', body: 'Body', tag: 'en_1', silent: true });
    expect(calls[1]?.args).toContain('--replace-id=17');
    expect(calls[1]?.args).toContain('--hint=boolean:suppress-sound:true');
    expect(await removeToast('en_1', { platform: 'linux', notifier })).toEqual({ kind: 'removed' });
    expect(calls[2]?.file).toBe('/usr/bin/gdbus');
    expect(calls[2]?.args.slice(-2)).toEqual(['org.freedesktop.Notifications.CloseNotification', '17']);
    // Nothing shown under that tag any more: no call.
    expect(await notifier.remove('en_1')).toEqual({ kind: 'removed' });
    expect(calls).toHaveLength(3);
  });

  it('with a click target: a waiting notify-send; a click opens the URI with xdg-open', async () => {
    const { run, calls } = linuxRun();
    const { spawn, started, children } = linuxSpawn();
    const notifier = createLinuxNotifier({ env: DESKTOP, run, tool, spawn });
    const shown = notifier.show({
      title: 'T',
      body: 'B',
      tag: 'en_1',
      launchUri: ENTRY_URI,
      actionLabel: 'Öffnen',
    });
    await settle();
    children[0]?.print('41');
    expect(await shown).toEqual({ kind: 'shown' });
    expect(started[0]?.file).toBe('/usr/bin/notify-send');
    expect(started[0]?.args).toContain('--action=default=Öffnen');
    expect(started[0]?.args).toContain('--wait');
    children[0]?.print('default');
    await settle();
    expect(started[1]).toEqual({ file: '/usr/bin/xdg-open', args: [ENTRY_URI], stdio: 'ignore' });
    children[0]?.exit(0);
    // A newer toast of the same tag replaces the old one and ends its waiter.
    const next = notifier.show({ title: 'T2', body: 'B', tag: 'en_1', launchUri: ENTRY_URI });
    await settle();
    children[2]?.print('41');
    expect(await next).toEqual({ kind: 'shown' });
    expect(started[2]?.args).toContain('--replace-id=41');
    expect(started[2]?.args).toContain('--action=default=Open');
    expect(await notifier.remove('en_1')).toEqual({ kind: 'removed' });
    expect(children[2]?.killed).toEqual(['SIGTERM']);
    expect(calls.map((c) => c.args.at(-1))).toEqual(['41']);
    // A URI that is no session link gets no click (one plain notify-send).
    await notifier.show({ title: 'T', body: 'B', tag: 'en_2', launchUri: 'https://example.invalid' });
    expect(calls.at(-1)?.file).toBe('/usr/bin/notify-send');
    expect(started).toHaveLength(3);
  });

  it('fallbacks: an old notify-send (no --wait/--print-id) and a missing one → gdbus Notify', async () => {
    const old = linuxRun({ notify: { exitCode: 1, stdout: '', stderr: 'Unknown option --print-id' } });
    const { spawn, children } = linuxSpawn();
    const notifier = createLinuxNotifier({ env: DESKTOP, run: old.run, tool, spawn });
    const shown = notifier.show({
      title: "It's",
      body: 'B',
      tag: 'en_1',
      launchUri: ENTRY_URI,
      silent: true,
    });
    await settle();
    children[0]?.exit(1);
    expect(await shown).toEqual({ kind: 'shown' });
    expect(old.calls.map((c) => c.file)).toEqual(['/usr/bin/notify-send', '/usr/bin/gdbus']);
    expect(old.calls[1]?.args.slice(7)).toEqual([
      'org.freedesktop.Notifications.Notify',
      "'Parallax'",
      '0',
      "''",
      String.raw`'It\'s'`,
      "'B'",
      '[]',
      "{'desktop-entry': <'parallax'>, 'suppress-sound': <true>}",
      '-1',
    ]);
    // The id of the bus reply is remembered for the next replace.
    await notifier.show({ title: 'Again', body: 'B', tag: 'en_1' });
    expect(old.calls.at(-1)?.args).toContain('23');

    const missing = linuxRun({ notify: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
    const bus = createLinuxNotifier({ env: DESKTOP, run: missing.run, tool, spawn: linuxSpawn().spawn });
    expect(await bus.show({ title: 'T', body: 'B', tag: 'en_1' })).toEqual({ kind: 'shown' });
    expect(missing.calls.map((c) => c.file)).toEqual(['/usr/bin/notify-send', '/usr/bin/gdbus']);
  });

  it('permanent: no graphical session, no programs, no notification server; others may pass', async () => {
    const { run, calls } = linuxRun();
    const headless = createLinuxNotifier({ env: { PATH: '/usr/bin' }, run, tool });
    expect(await headless.show({ title: 'T', body: 'B', tag: 'x' })).toEqual({
      kind: 'failed',
      reason: 'no graphical session',
      permanent: true,
    });
    expect(calls).toEqual([]);
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const none = linuxRun({ notify: enoent, gdbus: enoent });
    expect(
      await createLinuxNotifier({ env: DESKTOP, run: none.run, tool }).show({
        title: 'T',
        body: 'B',
        tag: 'x',
      }),
    ).toEqual({
      kind: 'failed',
      reason: 'gdbus could not be started: spawn ENOENT',
      permanent: true,
    });
    const noServer = linuxRun({
      notify: { exitCode: 1, stdout: '' },
      gdbus: {
        exitCode: 1,
        stdout: '',
        stderr: 'GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: no owner',
      },
    });
    expect(
      await createLinuxNotifier({ env: DESKTOP, run: noServer.run, tool }).show({
        title: 'T',
        body: 'B',
        tag: 'x',
      }),
    ).toMatchObject({
      kind: 'failed',
      permanent: true,
    });
    const slow = linuxRun({ notify: { timedOut: true, exitCode: null, stdout: '' } });
    expect(
      await createLinuxNotifier({ env: DESKTOP, run: slow.run, tool }).show({
        title: 'T',
        body: 'B',
        tag: 'x',
      }),
    ).toEqual({
      kind: 'failed',
      reason: 'notify-send timeout',
      permanent: false,
    });
    const busy = linuxRun({
      notify: { exitCode: 1, stdout: '' },
      gdbus: { exitCode: 1, stdout: '', stderr: 'Timeout was reached' },
    });
    expect(
      await createLinuxNotifier({ env: DESKTOP, run: busy.run, tool }).show({
        title: 'T',
        body: 'B',
        tag: 'x',
      }),
    ).toEqual({
      kind: 'failed',
      reason: 'gdbus exit 1: Timeout was reached',
      permanent: false,
    });
  });

  it('a waiter that prints no id in time is ended; the toast counts as a transient failure', async () => {
    const { run } = linuxRun();
    const { spawn, children } = linuxSpawn();
    const notifier = createLinuxNotifier({ env: DESKTOP, run, tool, spawn, timeoutMs: 20 });
    expect(await notifier.show({ title: 'T', body: 'B', tag: 'x', launchUri: ENTRY_URI })).toEqual({
      kind: 'failed',
      reason: 'notify-send timeout',
      permanent: false,
    });
    expect(children[0]?.killed).toEqual(['SIGTERM']);
  });
});
