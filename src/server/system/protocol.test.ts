import { describe, expect, it } from 'vitest';
import type { RunFileFn, RunFileResult } from '../lib/process';
import type { RegAddValue, RegDeleteKey, RegWriteResult } from '../lib/registry';
import type { StartCommand } from './autostart';
import {
  FOREIGN_HANDLER,
  PROTOCOL_COMMAND_KEY,
  PROTOCOL_KEY,
  isOwnCommand,
  protocolCommand,
  regKeyReader,
  registerProtocolHandler,
  unregisterProtocolHandler,
  type ProtocolRegistryDeps,
  type RegKeyRead,
  type RegKeyReader,
} from './protocol';

const COMMAND: StartCommand = {
  node: 'C:\\Program Files\\nodejs\\node.exe',
  args: [
    'D:\\dev\\Parallax Repo\\node_modules\\tsx\\dist\\cli.mjs',
    '--tsconfig',
    'D:\\dev\\Parallax Repo\\src\\server\\tsconfig.json',
    'D:\\dev\\Parallax Repo\\src\\server\\launcher\\main.ts',
  ],
  cwd: 'D:\\dev\\Parallax Repo',
};

/** `reg query <key> /ve` output as printed by reg.exe. */
const queryOutput = (value: string) =>
  `\r\nHKEY_CURRENT_USER\\Software\\Classes\\parallax\\shell\\open\\command\r\n    (Default)    REG_SZ    ${value}\r\n\r\n`;

/**
 * A fake HKCU behind the reader: `existing` = the default value of `shell\open\command` (null = no
 * such key); the scheme key exists with a command or with `schemeKey`; `failed` fails every query.
 */
function registry(
  existing: string | null,
  add: RegWriteResult = { ok: true },
  opts: { schemeKey?: boolean; failed?: string } = {},
) {
  const adds: [string, string | null, string][] = [];
  const removes: string[] = [];
  const reads: string[] = [];
  const read: RegKeyReader = (key) => {
    reads.push(key);
    let answer: RegKeyRead;
    if (opts.failed !== undefined) answer = { state: 'failed', reason: opts.failed };
    else if (key === PROTOCOL_COMMAND_KEY) {
      answer = existing === null ? { state: 'missing' } : { state: 'present', output: queryOutput(existing) };
    } else {
      answer =
        existing !== null || opts.schemeKey === true
          ? { state: 'present', output: queryOutput('(value not set)') }
          : { state: 'missing' };
    }
    return Promise.resolve(answer);
  };
  const addValue: RegAddValue = (key, name, data) => {
    adds.push([key, name, data]);
    return Promise.resolve(add);
  };
  const remove: RegDeleteKey = (key) => {
    removes.push(key);
    return Promise.resolve({ ok: true });
  };
  const deps: ProtocolRegistryDeps = { read, add: addValue, remove };
  return { deps, adds, removes, reads };
}

describe('protocol handler parallax: (ADR-109)', () => {
  it('command: quoted node, the launcher arguments, --open "%1" last', () => {
    expect(protocolCommand(COMMAND)).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "D:\\dev\\Parallax Repo\\node_modules\\tsx\\dist\\cli.mjs" ' +
        '--tsconfig "D:\\dev\\Parallax Repo\\src\\server\\tsconfig.json" ' +
        '"D:\\dev\\Parallax Repo\\src\\server\\launcher\\main.ts" --open "%1"',
    );
    expect(isOwnCommand(protocolCommand(COMMAND))).toBe(true);
    expect(isOwnCommand('"C:\\Other\\app.exe" "%1"')).toBe(false);
  });

  it('registers the three values under HKCU\\Software\\Classes\\parallax (the command first)', async () => {
    const r = registry(null);
    const command = protocolCommand(COMMAND);
    expect(await registerProtocolHandler(command, r.deps)).toEqual({ ok: true });
    // No command and no scheme key: the scheme is free.
    expect(r.reads).toEqual([PROTOCOL_COMMAND_KEY, PROTOCOL_KEY]);
    expect(r.adds).toEqual([
      ['HKCU\\Software\\Classes\\parallax\\shell\\open\\command', null, command],
      [PROTOCOL_KEY, null, 'URL:Parallax'],
      [PROTOCOL_KEY, 'URL Protocol', ''],
    ]);
  });

  it('refreshes an own handler (another node path or repo), never a foreign one', async () => {
    const own = registry('"C:\\old\\node.exe" "C:\\old repo\\src\\server\\Launcher\\Main.ts" --open "%1"');
    expect(await registerProtocolHandler(protocolCommand(COMMAND), own.deps)).toEqual({ ok: true });
    expect(own.adds).toHaveLength(3);
    const foreign = registry('"C:\\Program Files\\Other\\other.exe" "%1"');
    expect(await registerProtocolHandler(protocolCommand(COMMAND), foreign.deps)).toEqual({
      ok: false,
      reason: FOREIGN_HANDLER,
    });
    expect(foreign.adds).toEqual([]);
  });

  it('stops at the first failed write', async () => {
    const r = registry(null, { ok: false, reason: 'reg.exe exit 1: denied' });
    expect(await registerProtocolHandler(protocolCommand(COMMAND), r.deps)).toEqual({
      ok: false,
      reason: 'reg.exe exit 1: denied',
    });
    expect(r.adds).toHaveLength(1);
  });

  it('removes only the own key; a missing or foreign one is left alone', async () => {
    const own = registry(protocolCommand(COMMAND));
    expect(await unregisterProtocolHandler(own.deps)).toEqual({ ok: true });
    expect(own.removes).toEqual([PROTOCOL_KEY]);
    const foreign = registry('"C:\\Other\\app.exe" "%1"');
    expect(await unregisterProtocolHandler(foreign.deps)).toEqual({ ok: true });
    expect(foreign.removes).toEqual([]);
    const missing = registry(null);
    expect(await unregisterProtocolHandler(missing.deps)).toEqual({ ok: true });
    expect(missing.removes).toEqual([]);
    const keyOnly = registry(null, { ok: true }, { schemeKey: true });
    expect(await unregisterProtocolHandler(keyOnly.deps)).toEqual({ ok: true });
    expect(keyOnly.removes).toEqual([]);
  });

  it('CR2-01: a failed query writes and removes nothing (never read as "no handler")', async () => {
    const reason = 'registry query: reg.exe timed out';
    const register = registry(null, { ok: true }, { failed: reason });
    expect(await registerProtocolHandler(protocolCommand(COMMAND), register.deps)).toEqual({
      ok: false,
      reason,
    });
    expect(register.adds).toEqual([]);
    const unregister = registry(null, { ok: true }, { failed: reason });
    expect(await unregisterProtocolHandler(unregister.deps)).toEqual({ ok: false, reason });
    expect(unregister.removes).toEqual([]);
  });

  it('CR2-01: a scheme key without shell\\open\\command, or a command without a default value, is foreign', async () => {
    const keyOnly = registry(null, { ok: true }, { schemeKey: true });
    expect(await registerProtocolHandler(protocolCommand(COMMAND), keyOnly.deps)).toEqual({
      ok: false,
      reason: FOREIGN_HANDLER,
    });
    expect(keyOnly.adds).toEqual([]);
    // DelegateExecute handler: reg.exe prints the localized "(value not set)" as REG_SZ.
    const delegate = registry('(Wert nicht festgelegt)');
    expect(await registerProtocolHandler(protocolCommand(COMMAND), delegate.deps)).toEqual({
      ok: false,
      reason: FOREIGN_HANDLER,
    });
    expect(delegate.adds).toEqual([]);
  });
});

describe('regKeyReader (CR2-01): reg.exe query judged by the exit code', () => {
  function fakeRun(result: Partial<RunFileResult> | Error) {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run: RunFileFn = (file, args) => {
      calls.push({ file, args });
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...result });
    };
    return { run, calls };
  }

  it('exit 0 → present with the output, exit 1 → missing', async () => {
    const present = fakeRun({ stdout: queryOutput('x') });
    expect(await regKeyReader(present.run)(PROTOCOL_KEY)).toEqual({ state: 'present', output: queryOutput('x') });
    expect(present.calls[0]?.file.toLowerCase()).toMatch(/\\system32\\reg\.exe$/);
    expect(present.calls[0]?.args).toEqual(['query', PROTOCOL_KEY, '/ve', '/reg:64']);
    const missing = fakeRun({ exitCode: 1, stderr: 'FEHLER: … nicht gefunden.' });
    expect(await regKeyReader(missing.run)(PROTOCOL_KEY)).toEqual({ state: 'missing' });
  });

  it('timeout, another exit code and a failed start → failed with a reason', async () => {
    expect(await regKeyReader(fakeRun({ timedOut: true, exitCode: null }).run)(PROTOCOL_KEY)).toEqual({
      state: 'failed',
      reason: 'registry query: reg.exe timed out',
    });
    expect(await regKeyReader(fakeRun({ exitCode: 5, stderr: 'boom' }).run)(PROTOCOL_KEY)).toEqual({
      state: 'failed',
      reason: 'registry query: reg.exe exit 5: boom',
    });
    expect(await regKeyReader(fakeRun({ exitCode: null, signal: 'SIGKILL' }).run)(PROTOCOL_KEY)).toEqual({
      state: 'failed',
      reason: 'registry query: reg.exe exit null: ',
    });
    expect(await regKeyReader(fakeRun(new Error('spawn EPERM')).run)(PROTOCOL_KEY)).toEqual({
      state: 'failed',
      reason: 'registry query: reg.exe could not be started: spawn EPERM',
    });
  });
});
