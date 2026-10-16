import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STANDARD_PROFILE_ID, type ProfileId } from '@shared/common';
import { HOST_COMMAND_NAMES, commandResultSchemas, type HostCommand } from '@shared/protocol';
import { SAMPLE_IDS, sampleClaudeInstallStatus, sampleId, sampleProfileInput } from '@shared/samples';
import type { RunFileOptions, RunFileResult } from '../lib/process';
import { createMemoryFs } from '../lib/windows';
import { createStoreWarnings } from '../store/jsonStore';
import { CommandError, type CommandContext } from '../sync/ports';
import { createClaudeIntegration } from './integration';
import { PROFILE_COMMAND_NAMES, createProfileCommands } from './profileCommands';
import { openProfileStore, type PersistentProfileStore } from './profileStore';
import { createProfileStore } from './profiles';

const LOCAL = 'C:\\Users\\u\\.local\\bin\\claude.exe';
const NOW = new Date('2026-10-16T10:00:00.000Z');
const CTX: CommandContext = { clientId: SAMPLE_IDS.client, cmdId: SAMPLE_IDS.cmdId };
const AUTH_OK = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
});

function result(stdout: string): RunFileResult {
  return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false };
}

async function setup(counts: Record<string, number> = {}) {
  const home = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp32-commands-'));
  const store = await openProfileStore({
    home,
    warnings: createStoreWarnings(),
    debounceMs: 5,
    issueContext: () => ({ env: {}, persistentEnv: new Map(), exists: () => true }),
  });
  const calls: { args: readonly string[]; options: RunFileOptions }[] = [];
  const run = (_file: string, args: readonly string[], options: RunFileOptions): Promise<RunFileResult> => {
    calls.push({ args, options });
    return Promise.resolve(result(args[0] === '--version' ? '2.1.300 (Claude Code)\n' : AUTH_OK));
  };
  const integration = createClaudeIntegration({
    appVersion: '1.2.3',
    profiles: store,
    baseEnv: () => ({ Path: 'C:\\Windows', CLAUDECODE: '1' }),
    persistentEnv: () => Promise.resolve(null),
    fs: createMemoryFs({ [LOCAL]: '' }),
    where: () => Promise.resolve([LOCAL]),
    runFile: run,
    sdkClaudeCodeVersion: '2.1.296',
    now: () => new Date('2026-10-15T08:00:00.000Z'),
  });
  const commands = createProfileCommands({
    store,
    integration,
    entryCount: (id: ProfileId) => counts[id] ?? 0,
    now: () => NOW,
  });
  const handle = (cmd: HostCommand): Promise<unknown> => commands.handle(cmd, CTX);
  return { home, store, integration, commands, handle, calls };
}

async function commandError(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error('expected a CommandError');
}

function saveWork(store: PersistentProfileStore): ProfileId {
  return store.save(sampleProfileInput(), NOW).id;
}

describe('createProfileCommands', () => {
  it('handles exactly the profile.* host commands', async () => {
    const { commands } = await setup();
    expect([...commands.names]).toEqual(HOST_COMMAND_NAMES.filter((name) => name.startsWith('profile.')));
    expect(PROFILE_COMMAND_NAMES).toHaveLength(6);
  });

  it('profile.get: the full profile with env, fresh issues and entryCount', async () => {
    const { store, handle } = await setup();
    const id = saveWork(store);
    const answer = commandResultSchemas['profile.get'].parse(
      await handle({ name: 'profile.get', profileId: id }),
    );
    expect(answer.profile).toEqual(store.get(id));
    expect(answer.profile.env).toEqual(sampleProfileInput().env);
    expect(answer.issues).toEqual([]);
    expect(answer.entryCount).toBe(0);
    expect(
      (await commandError(handle({ name: 'profile.get', profileId: sampleId('pf', 9) }))).error.code,
    ).toBe('PROFILE_NOT_FOUND');
  });

  it('profile.get counts the entries of the profile', async () => {
    const { handle } = await setup({ [STANDARD_PROFILE_ID]: 3 });
    const answer = commandResultSchemas['profile.get'].parse(
      await handle({ name: 'profile.get', profileId: STANDARD_PROFILE_ID }),
    );
    expect(answer.entryCount).toBe(3);
  });

  it('profile.save → {profileId}; error issues → PROFILE_INVALID', async () => {
    const { store, handle } = await setup();
    const answer = commandResultSchemas['profile.save'].parse(
      await handle({ name: 'profile.save', profile: sampleProfileInput() }),
    );
    expect(store.get(answer.profileId)?.name).toBe('Work');
    const error = await commandError(
      handle({ name: 'profile.save', profile: sampleProfileInput({ args: ['--print'] }) }),
    );
    expect(error.error).toEqual({ code: 'PROFILE_INVALID', params: { count: 1 } });
  });

  it('profile.delete: built-in → PROFILE_NOT_DELETABLE, in use → PROFILE_IN_USE {count}, else removed', async () => {
    const counts: Record<string, number> = {};
    const { store, handle } = await setup(counts);
    const id = saveWork(store);
    expect(
      (await commandError(handle({ name: 'profile.delete', profileId: STANDARD_PROFILE_ID }))).error,
    ).toEqual({ code: 'PROFILE_NOT_DELETABLE', params: { profileId: STANDARD_PROFILE_ID } });
    counts[id] = 2;
    expect((await commandError(handle({ name: 'profile.delete', profileId: id }))).error).toEqual({
      code: 'PROFILE_IN_USE',
      params: { count: 2 },
    });
    expect(store.get(id)).toBeDefined();
    counts[id] = 0;
    expect(
      commandResultSchemas['profile.delete'].parse(await handle({ name: 'profile.delete', profileId: id })),
    ).toEqual({});
    expect(store.get(id)).toBeUndefined();
    expect((await commandError(handle({ name: 'profile.delete', profileId: id }))).error.code).toBe(
      'PROFILE_NOT_FOUND',
    );
  });

  it('profile.setDefault', async () => {
    const { store, handle } = await setup();
    const id = saveWork(store);
    expect(await handle({ name: 'profile.setDefault', profileId: id })).toEqual({});
    expect(store.getDefault().id).toBe(id);
  });

  it('profile.test runs the check with the profile env and stores the result (onChange)', async () => {
    const { store, handle, calls } = await setup();
    const id = saveWork(store);
    let changes = 0;
    store.onChange(() => {
      changes += 1;
    });
    const answer = commandResultSchemas['profile.test'].parse(
      await handle({ name: 'profile.test', profileId: id }),
    );
    expect(answer.claude).toEqual(
      sampleClaudeInstallStatus({ path: LOCAL, checkedAt: '2026-10-15T08:00:00.000Z' }),
    );
    expect(store.claudeStatus(id)).toEqual(answer.claude);
    expect(store.summaries().find((s) => s.id === id)?.claude).toEqual(answer.claude);
    expect(changes).toBe(1);
    expect(calls.map((call) => call.args.join(' '))).toEqual(['--version', 'auth status --json']);
    for (const call of calls) {
      expect(call.options.env).toMatchObject({
        CLAUDE_CONFIG_DIR: 'C:\\Users\\user\\.claude-work',
        API_TOKEN: 'secret',
      });
      expect(call.options.env?.CLAUDECODE).toBeUndefined();
    }
    expect(
      (await commandError(handle({ name: 'profile.test', profileId: sampleId('pf', 9) }))).error.code,
    ).toBe('PROFILE_NOT_FOUND');
  });

  it('profile.test reports into the store even if the integration reads another one', async () => {
    const { store } = await setup();
    const fake = {
      profiles: createProfileStore(),
      launchSpecFor: () => Promise.reject(new Error('unused')),
      consoleLaunchFor: () => Promise.reject(new Error('unused')),
      checkProfile: () => Promise.resolve(sampleClaudeInstallStatus()),
    };
    const commands = createProfileCommands({ store, integration: fake, entryCount: () => 0, now: () => NOW });
    await commands.handle({ name: 'profile.test', profileId: STANDARD_PROFILE_ID }, CTX);
    expect(store.claudeStatus(STANDARD_PROFILE_ID)).toEqual(sampleClaudeInstallStatus());
  });

  it('profile.validate returns the issues and writes nothing', async () => {
    const { home, store, handle } = await setup();
    const answer = commandResultSchemas['profile.validate'].parse(
      await handle({
        name: 'profile.validate',
        profile: sampleProfileInput({
          args: ['--resume', 'x', '--allowedTools', '*'],
          configDir: 'relative',
        }),
      }),
    );
    expect(answer.issues.map((i) => [i.level, i.issue.code])).toEqual([
      ['error', 'PROFILE_ARG_BLOCKED'],
      ['error', 'PROFILE_INVALID'],
      ['warning', 'PROFILE_ARG_BROAD_ALLOWED_TOOLS'],
    ]);
    await store.flush();
    expect(await readdir(home)).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  it('answers NOT_IMPLEMENTED for host commands it does not own', async () => {
    const { handle } = await setup();
    expect(
      (await commandError(handle({ name: 'fs.listDirectory', path: null, showHidden: false }))).error.code,
    ).toBe('NOT_IMPLEMENTED');
  });
});
