import { describe, expect, it } from 'vitest';
import type { RunFileFn, RunFileOptions } from './process';
import {
  TOAST_APP_ID,
  TOAST_GROUP,
  TOAST_SCRIPT,
  encodePowerShell,
  removeToast,
  showToast,
  toastTemplateXml,
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

  it.each([
    ['no launchUri', undefined],
    ['null', null],
    ['another scheme', 'https://evil.example/session/x'],
    ['a malformed id', 'parallax://session/en_1"/><x'],
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
    expect(await showToast({ title: 't', body: 'b', tag: 'x' }, { run, platform: 'linux' })).toEqual({
      kind: 'failed',
      reason: 'not Windows',
      permanent: true,
    });
    expect(calls).toEqual([]);
  });
});
