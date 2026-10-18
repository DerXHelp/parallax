import { describe, expect, it } from 'vitest';
import type { ConsoleLaunchSpec } from '../claude/ports';
import { windowsCommandLine } from '../lib/cmdline';
import { encodePowerShell } from '../lib/powershell';
import type { RunFileFn, RunFileOptions, RunFileResult } from '../lib/process';
import {
  CONSOLE_ENV,
  CONSOLE_SCRIPT,
  CONSOLE_TIMEOUT_MS,
  createConsoleLauncher,
  parseConsoleOutput,
} from './console';

interface Call {
  file: string;
  args: readonly string[];
  options: RunFileOptions;
}

function fakeRun(result: Partial<RunFileResult> | Error = {}): { run: RunFileFn; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunFileFn = (file, args, options) => {
    calls.push({ file, args, options });
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: 'pid=4242;start=2026-10-16T08:00:00.123Z\r\n',
      stderr: '',
      timedOut: false,
      ...result,
    });
  };
  return { run, calls };
}

const SPEC: ConsoleLaunchSpec = {
  executablePath: 'C:\\Users\\u\\.local\\bin\\claude.exe',
  args: [
    '--resume',
    '9b779de6-0000-4000-8000-000000000001',
    '--model',
    'claude opus',
    '--settings',
    '{"a":"b c"}',
  ],
  env: {
    SystemRoot: 'C:\\Windows',
    PATH: 'C:\\Windows',
    PARALLAX: '1',
    PARALLAX_ENTRY_ID: 'en_0123456789abcdef0123456789abcdef',
    PARALLAX_CONSOLE_EXE: 'C:\\inherited.exe',
  },
  explicitEnv: {},
  cwd: 'D:\\work\\Projekt Ärger',
};

describe('createConsoleLauncher().open (ADR-104)', () => {
  it('runs the constant script hidden through PowerShell; the data only in the environment', async () => {
    const { run, calls } = fakeRun();
    const result = await createConsoleLauncher({ run, platform: 'win32' }).open(SPEC);
    expect(result).toEqual({
      kind: 'opened',
      process: { pid: 4242, startedAt: new Date('2026-10-16T08:00:00.123Z') },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('no call');
    expect(call.file.toLowerCase()).toMatch(
      /^[a-z]:\\windows\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/,
    );
    // R4-04: no -ExecutionPolicy (it would hand PSExecutionPolicyPreference=Bypass to the console).
    expect(call.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShell(CONSOLE_SCRIPT),
    ]);
    expect(call.options.timeoutMs).toBe(CONSOLE_TIMEOUT_MS);
    // spec.env + the three variables (an inherited one is overridden).
    expect(call.options.env).toEqual({
      ...SPEC.env,
      [CONSOLE_ENV.exe]: SPEC.executablePath,
      [CONSOLE_ENV.args]: windowsCommandLine(SPEC.args),
      [CONSOLE_ENV.cwd]: SPEC.cwd,
    });
    // Nothing of the data is in the command line or the script.
    for (const text of [call.args.join(' '), CONSOLE_SCRIPT]) {
      expect(text).not.toContain('claude.exe');
      expect(text).not.toContain('--resume');
      expect(text).not.toContain('Ärger');
    }
  });

  it('the script removes its variables before Start-Process and never uses cmd or a shell', () => {
    const lines = CONSOLE_SCRIPT.split('\n');
    const remove = lines.findIndex((l) => l.includes('Remove-Item'));
    const start = lines.findIndex((l) => l.includes('Start-Process'));
    expect(remove).toBeGreaterThan(0);
    expect(remove).toBeLessThan(start);
    for (const name of Object.values(CONSOLE_ENV)) expect(lines[remove - 1]).toContain(name);
    expect(CONSOLE_SCRIPT).toContain(
      'Start-Process -FilePath $exe -ArgumentList $line -WorkingDirectory $cwd -PassThru',
    );
    // Without arguments no -ArgumentList (Start-Process rejects an empty one).
    expect(CONSOLE_SCRIPT).toContain('Start-Process -FilePath $exe -WorkingDirectory $cwd -PassThru');
    expect(CONSOLE_SCRIPT).not.toMatch(/cmd(\.exe)?\b|Invoke-Expression|iex\b/i);
    expect(CONSOLE_SCRIPT).toContain('exit 3');
  });

  it("R4-04: PowerShell's own PSModulePath/PSExecutionPolicyPreference are set back to the spec's before Start-Process", async () => {
    const lines = CONSOLE_SCRIPT.split('\n');
    const start = lines.findIndex((l) => l.includes('Start-Process'));
    for (const name of ['PSModulePath', 'PSExecutionPolicyPreference']) {
      const set = lines.findIndex((l) => l.includes(`$env:${name} =`));
      const removed = lines.findIndex((l) => l.includes(`'Env:${name}'`) && l.includes('Remove-Item'));
      expect(set).toBeGreaterThan(0);
      expect(set).toBeLessThan(start);
      expect(removed).toBeGreaterThan(0);
      expect(removed).toBeLessThan(start);
    }
    expect(CONSOLE_SCRIPT).not.toMatch(/ExecutionPolicy\s+Bypass/i);

    // With the variables in the spec (any case): their values travel in the carriers.
    const { run, calls } = fakeRun();
    const env = { ...SPEC.env, psmodulepath: 'C:\\Users\\u\\Documents\\PowerShell\\Modules' };
    await createConsoleLauncher({ run, platform: 'win32' }).open({ ...SPEC, env });
    expect(calls[0]?.options.env).toMatchObject({
      [CONSOLE_ENV.psModulePath]: 'C:\\Users\\u\\Documents\\PowerShell\\Modules',
    });
    expect(calls[0]?.options.env).not.toHaveProperty(CONSOLE_ENV.psPolicy);
    // Without them: no carrier (the script removes both from the console's environment).
    const plain = fakeRun();
    await createConsoleLauncher({ run: plain.run, platform: 'win32' }).open({
      ...SPEC,
      env: { ...SPEC.env, parallax_console_pspolicy: 'Bypass' },
    });
    const keys = Object.keys(plain.calls[0]?.options.env ?? {}).map((k) => k.toUpperCase());
    expect(keys).not.toContain(CONSOLE_ENV.psPolicy);
    expect(keys).not.toContain(CONSOLE_ENV.psModulePath);
  });

  it('empty args travel as an empty line', async () => {
    const { run, calls } = fakeRun();
    await createConsoleLauncher({ run, platform: 'win32' }).open({ ...SPEC, args: [] });
    expect(calls[0]?.options.env?.[CONSOLE_ENV.args]).toBe('');
  });

  it.each<[string, Partial<RunFileResult> | Error, RegExp]>([
    [
      'script failure (exit 3)',
      { exitCode: 3, stdout: 'error: This command cannot be run (AppLocker).' },
      /exit 3: error: This command/,
    ],
    ['a timeout', { exitCode: null, timedOut: true, stdout: '' }, /^timeout$/],
    ['unreadable output', { stdout: 'something else' }, /exit 0: something else/],
    ['PowerShell missing', new Error('spawn ENOENT'), /powershell could not be started: spawn ENOENT/],
  ])('%s → failed with the reason, never thrown', async (_name, outcome, reason) => {
    const { run } = fakeRun(outcome);
    const result = await createConsoleLauncher({ run, platform: 'win32' }).open(SPEC);
    if (result.kind !== 'failed') throw new Error('expected failed');
    expect(result.reason).toMatch(reason);
  });

  it.each<[string, Partial<ConsoleLaunchSpec>, NodeJS.Platform, RegExp]>([
    ['not Windows', {}, 'linux', /not Windows/],
    ['a bare name', { executablePath: 'claude' }, 'win32', /only \.exe files/],
    ['a .cmd shim', { executablePath: 'C:\\npm\\claude.cmd' }, 'win32', /only \.exe files/],
    ['a UNC exe', { executablePath: '\\\\server\\share\\claude.exe' }, 'win32', /absolute \.exe/],
    ['a UNC cwd', { cwd: '\\\\server\\share' }, 'win32', /working directory rejected \(unc\)/],
  ])('refuses %s without starting anything', async (_name, patch, platform, reason) => {
    const { run, calls } = fakeRun();
    const result = await createConsoleLauncher({ run, platform }).open({ ...SPEC, ...patch });
    if (result.kind !== 'failed') throw new Error('expected failed');
    expect(result.reason).toMatch(reason);
    expect(calls).toEqual([]);
  });

  it('parses pid and start time; an empty start time is null', () => {
    expect(parseConsoleOutput('pid=17;start=')).toEqual({ pid: 17, startedAt: null });
    expect(parseConsoleOutput('noise\npid=17;start=2026-10-16T08:00:00.000Z')).toEqual({
      pid: 17,
      startedAt: new Date('2026-10-16T08:00:00.000Z'),
    });
    expect(parseConsoleOutput('pid=0;start=')).toBeNull();
    expect(parseConsoleOutput('error: x')).toBeNull();
  });
});

describe('createConsoleLauncher().state (ADR-104, ADR-051)', () => {
  const started = new Date('2026-10-16T08:00:00.000Z');
  const state = (
    opts: Parameters<typeof createConsoleLauncher>[0],
    startedAt: Date | null = started,
    pid: number | null = 4242,
  ) => createConsoleLauncher({ platform: 'win32', run: fakeRun().run, ...opts }).state({ pid, startedAt });

  it('running, ended (gone or PID reused), unknown (no pid, failed query)', async () => {
    const alive = () => true;
    expect(await state({ isAlive: () => false })).toBe('ended');
    expect(
      await state({ isAlive: alive, startTime: () => Promise.resolve(new Date(started.getTime() + 4_000)) }),
    ).toBe('running');
    expect(
      await state({ isAlive: alive, startTime: () => Promise.resolve(new Date(started.getTime() + 60_000)) }),
    ).toBe('ended');
    expect(await state({ isAlive: alive, startTime: () => Promise.resolve(null) })).toBe('unknown');
    expect(await state({ isAlive: alive, startTime: () => Promise.reject(new Error('x')) })).toBe('unknown');
    expect(await state({ isAlive: alive }, null)).toBe('running');
    expect(await state({ isAlive: alive }, started, null)).toBe('unknown');
  });

  it('R4-05: the creation time once per process, then only the liveness check; again after CONSOLE_RECHECK_MS', async () => {
    let clock = 0;
    let alive = true;
    const queries: number[] = [];
    let actual = new Date(started.getTime() + 1_000);
    const launcher = createConsoleLauncher({
      platform: 'win32',
      run: fakeRun().run,
      isAlive: () => alive,
      now: () => clock,
      startTime: (pid) => {
        queries.push(pid);
        return Promise.resolve(actual);
      },
    });
    const proc = { pid: 4242, startedAt: started };
    // Two checks at once share one query.
    expect(await Promise.all([launcher.state(proc), launcher.state(proc)])).toEqual(['running', 'running']);
    for (let i = 0; i < 11; i += 1) {
      clock += 5_000;
      expect(await launcher.state(proc)).toBe('running');
    }
    expect(queries).toEqual([4242]);
    clock += 5_000;
    // 60 s after the first confirmation: verified again (PID reuse).
    actual = new Date(started.getTime() + 600_000);
    expect(await launcher.state(proc)).toBe('ended');
    expect(queries).toEqual([4242, 4242]);
    // A dead PID is `ended` at once, without any query.
    alive = false;
    expect(await launcher.state({ pid: 4243, startedAt: started })).toBe('ended');
    expect(queries).toHaveLength(2);
    // A failed query is not remembered.
    alive = true;
    const failing = createConsoleLauncher({
      platform: 'win32',
      run: fakeRun().run,
      isAlive: () => true,
      now: () => clock,
      startTime: (pid) => {
        queries.push(pid);
        return Promise.resolve(null);
      },
    });
    expect(await failing.state(proc)).toBe('unknown');
    expect(await failing.state(proc)).toBe('unknown');
    expect(queries).toHaveLength(4);
  });

  it('by default asks the process start time through the injected runner (CIM query)', async () => {
    const json = JSON.stringify([
      { pid: 4242, name: 'claude.exe', parentPid: 1, startedAt: '2026-10-16T08:00:01.000Z' },
    ]);
    const { run, calls } = fakeRun({ stdout: json });
    const launcher = createConsoleLauncher({ run, platform: 'win32', isAlive: () => true });
    expect(await launcher.state({ pid: 4242, startedAt: started })).toBe('running');
    expect(calls[0]?.args.join(' ')).toContain('ProcessId = 4242');
  });
});
