import { describe, expect, it } from 'vitest';
import type { RunFileFn, RunFileOptions } from './process';
import { TOAST_APP_ID, TOAST_GROUP, TOAST_SCRIPT, encodePowerShell, removeToast, showToast } from './toast';

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

  it.each<[string, RunFileFn, RegExp]>([
    [
      'CLM/AppLocker (exit 3)',
      fakeRun('error: Cannot create type.', 3).run,
      /exit 3: error: Cannot create type/,
    ],
    ['an unexpected answer', fakeRun('something').run, /exit 0: something/],
    [
      'a timeout',
      () => Promise.resolve({ exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }),
      /timeout/,
    ],
    [
      'PowerShell missing',
      () => Promise.reject(new Error('spawn ENOENT')),
      /could not be started: spawn ENOENT/,
    ],
  ])('%s → failed, never thrown', async (_name, run, reason) => {
    const result = await showToast({ title: 't', body: 'b', tag: 'x' }, { run, platform: 'win32', env: ENV });
    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' ? result.reason : '').toMatch(reason);
  });

  it('other platforms: failed without a call', async () => {
    const { run, calls } = fakeRun();
    expect(await showToast({ title: 't', body: 'b', tag: 'x' }, { run, platform: 'linux' })).toEqual({
      kind: 'failed',
      reason: 'not Windows',
    });
    expect(calls).toEqual([]);
  });
});
