import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import { isRemoteAllowedCommand, type HostCommand } from '@shared/protocol';
import { SAMPLE_IDS, sampleId, sampleSettings } from '@shared/samples';
import type { ConsoleLaunchSpec } from '../claude/ports';
import { createMemoryFs } from '../lib/windows';
import { CommandError } from '../sync/ports';
import type { ConsoleLauncher, ConsoleOpenResult } from '../system/ports';
import { createRecordingShellLauncher, createShellCommands, type ShellCommandsDeps } from './shellCommands';

const CWD = 'D:\\work\\proj';
const GIT = 'C:\\Program Files\\Git';
const ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  Path: 'C:\\Windows',
  CLAUDECODE: '1',
  PARALLAX_ENTRY_ID: 'en_parent',
};
const CTX = { clientId: SAMPLE_IDS.client, cmdId: SAMPLE_IDS.cmdId };

function launcher(result: ConsoleOpenResult = { kind: 'opened', process: { pid: 4242, startedAt: null } }) {
  const opened: ConsoleLaunchSpec[] = [];
  const fake: ConsoleLauncher = {
    open: (spec) => {
      opened.push(spec);
      return Promise.resolve(result);
    },
    state: () => Promise.resolve('unknown'),
  };
  return { fake, opened };
}

function commands(p: Partial<ShellCommandsDeps> & { launcher: ConsoleLauncher }) {
  return createShellCommands({
    entryCwd: (entryId) => (entryId === SAMPLE_IDS.entry ? CWD : null),
    settings: () => sampleSettings(),
    env: ENV,
    fs: createMemoryFs({ [`${GIT}\\git-bash.exe`]: '', [`${GIT}\\bin\\bash.exe`]: '' }),
    regKeyQuery: () => Promise.resolve(null),
    checkCwd: () => Promise.resolve(),
    ...p,
  });
}

const openShell = (shell: 'cmd' | 'powershell' | 'gitbash', entryId = SAMPLE_IDS.entry): HostCommand => ({
  name: 'session.openShell',
  entryId,
  shell,
});

async function errorPayload(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.catch((caught: unknown) => caught);
  return error instanceof CommandError ? error.error : error;
}

describe('session.openShell (WP-97, ADR-238)', () => {
  it('opens cmd in the stored cwd through the console launcher, neutral environment', async () => {
    const { fake, opened } = launcher();
    const result = await commands({ launcher: fake }).handle(openShell('cmd'), CTX);
    expect(result).toEqual({ pid: 4242 });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      executablePath: 'C:\\Windows\\System32\\cmd.exe',
      args: [],
      cwd: CWD,
      explicitEnv: {},
    });
    expect(opened[0]?.env).not.toHaveProperty('CLAUDECODE');
    expect(opened[0]?.env).not.toHaveProperty('PARALLAX_ENTRY_ID');
  });

  it('Git Bash with the window from the settings', async () => {
    const { fake, opened } = launcher();
    await commands({ launcher: fake }).handle(openShell('gitbash'), CTX);
    expect(opened[0]).toMatchObject({ executablePath: `${GIT}\\git-bash.exe`, args: [`--cd=${CWD}`] });
  });

  it('ENTRY_NOT_FOUND, cwd errors and SHELL_NOT_FOUND come before any launch', async () => {
    const { fake, opened } = launcher();
    expect(
      await errorPayload(commands({ launcher: fake }).handle(openShell('cmd', sampleId('en', 2)), CTX)),
    ).toEqual(makeError('ENTRY_NOT_FOUND'));
    const gone = commands({
      launcher: fake,
      checkCwd: () => Promise.reject(new CommandError(makeError('CWD_NOT_FOUND'))),
    });
    expect(await errorPayload(gone.handle(openShell('cmd'), CTX))).toEqual(makeError('CWD_NOT_FOUND'));
    const noGit = commands({
      launcher: fake,
      fs: createMemoryFs({}),
      env: { ...ENV, ProgramFiles: 'C:\\x' },
    });
    expect(await errorPayload(noGit.handle(openShell('gitbash'), CTX))).toEqual(
      makeError('SHELL_NOT_FOUND', { shell: 'gitbash' }),
    );
    expect(opened).toEqual([]);
  });

  it('a launcher failure becomes SHELL_OPEN_FAILED with a scrubbed reason', async () => {
    const { fake } = launcher({
      kind: 'failed',
      reason: 'exit 3: error: access denied token=sk-ant-abcdefghijklmnop',
    });
    const error = await errorPayload(commands({ launcher: fake }).handle(openShell('powershell'), CTX));
    expect(error).toMatchObject({ code: 'SHELL_OPEN_FAILED' });
    expect(JSON.stringify(error)).not.toContain('sk-ant-abcdefghijklmnop');
  });
});

describe('shell.detect', () => {
  it('the Git folder (override first), fresh every time', async () => {
    const { fake } = launcher();
    expect(await commands({ launcher: fake }).handle({ name: 'shell.detect' }, CTX)).toEqual({ gitDir: GIT });
    const none = commands({ launcher: fake, fs: createMemoryFs({}), env: { ...ENV, ProgramFiles: 'C:\\x' } });
    expect(await none.handle({ name: 'shell.detect' }, CTX)).toEqual({ gitDir: null });
  });
});

describe('remote access', () => {
  it('neither command is allowed from another computer', () => {
    expect(isRemoteAllowedCommand('session.openShell')).toBe(false);
    expect(isRemoteAllowedCommand('shell.detect')).toBe(false);
  });
});

describe('createRecordingShellLauncher', () => {
  it('opens nothing and records the spec', async () => {
    const recording = createRecordingShellLauncher();
    const spec: ConsoleLaunchSpec = {
      executablePath: 'C:\\Windows\\System32\\cmd.exe',
      args: [],
      env: {},
      explicitEnv: {},
      cwd: CWD,
    };
    expect(await recording.open(spec)).toEqual({ kind: 'opened', process: { pid: null, startedAt: null } });
    expect(recording.opened).toEqual([spec]);
  });
});
