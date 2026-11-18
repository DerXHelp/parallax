import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeError, type ErrorPayload } from '@shared/errors';
import { DEFAULT_MULTI_HOST_CONFIG, multiHostFileSchema, type MultiHostConfig } from '@shared/model';
import type { HostCommand } from '@shared/protocol';
import { makeTempHome } from '../http/testServer';
import { nodeFsOps, type FsOps } from '../lib/fs';
import { createMemoryKeyStore } from '../secure/memoryKeyStore';
import { TEST_HOST } from '../secure/testKit';
import { CommandError } from '../sync/ports';
import { createFakeHub, OPEN_LIMITS, testInstance } from '../remote/testKit';
import { createRemoteAccessService, type RemoteAccess } from '../remote/service';
import { createMultiHostService, type ManagedRoleSide } from './service';
import { MULTI_HOST_FILE, createMultiHostStore } from './store';

interface FakeSide<R extends 'share' | 'control'> extends ManagedRoleSide {
  readonly role: R;
  calls: string[];
  coupled: number;
  failNext: CommandError | null;
  fire(): void;
}

function fakeSide<R extends 'share' | 'control'>(role: R): FakeSide<R> {
  const listeners = new Set<() => void>();
  const side: FakeSide<R> = {
    role,
    calls: [],
    coupled: 0,
    failNext: null,
    couplings: () => side.coupled,
    prepare: () => {
      side.calls.push('prepare');
      return Promise.resolve();
    },
    activate: (config: MultiHostConfig) => {
      side.calls.push(`activate:${String(config.port)}`);
      const failure = side.failNext;
      side.failNext = null;
      return failure === null ? Promise.resolve() : Promise.reject(failure);
    },
    deactivate: () => {
      side.calls.push('deactivate');
      return Promise.resolve();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire: () => {
      for (const listener of listeners) listener();
    },
  };
  return side;
}

const ctx = { clientId: 'cl_00000000000000000000000000000001', cmdId: 'c' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(options: { control?: boolean; fs?: FsOps } = {}) {
  const home = await makeTempHome('wp78a-role-');
  const share = fakeSide('share');
  const control = options.control === false ? undefined : fakeSide('control');
  const store = createMultiHostStore({
    home,
    retryDelaysMs: [],
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  const service = createMultiHostService({
    home,
    share,
    ...(control === undefined ? {} : { control }),
    store,
  });
  const configure = (fields: Omit<Extract<HostCommand, { name: 'multiHost.configure' }>, 'name'>) =>
    service.commands.handle({ name: 'multiHost.configure', ...fields }, ctx) as Promise<{
      config: MultiHostConfig;
    }>;
  const file = path.join(home, MULTI_HOST_FILE);
  const readFileConfig = async (): Promise<MultiHostConfig | null> => {
    try {
      return multiHostFileSchema.parse(JSON.parse(await readFile(file, 'utf8'))).config;
    } catch {
      return null;
    }
  };
  return { home, share, control, service, configure, file, readFileConfig };
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

describe('role "Several computers" (§4.1, ADR-224)', () => {
  it('starts with the defaults and prepares both sides', async () => {
    const { service, share, control } = await setup();
    expect(service.config()).toEqual(DEFAULT_MULTI_HOST_CONFIG);
    await service.start();
    expect(service.config()).toEqual({ role: 'off', port: 4713, bindAddress: '0.0.0.0' });
    expect(share.calls).toEqual(['prepare']);
    expect(control?.calls).toEqual(['prepare']);
  });

  it('switches to share (side first, then the file) and back to off', async () => {
    const { service, share, configure, readFileConfig } = await setup();
    await service.start();
    let changes = 0;
    service.onChange(() => (changes += 1));
    expect(await configure({ role: 'share' })).toEqual({
      config: { role: 'share', port: 4713, bindAddress: '0.0.0.0' },
    });
    expect(share.calls).toEqual(['prepare', 'activate:4713']);
    expect(await readFileConfig()).toEqual({ role: 'share', port: 4713, bindAddress: '0.0.0.0' });
    expect(changes).toBe(1);
    await configure({ port: 5000 });
    expect(share.calls.at(-1)).toBe('activate:5000');
    await configure({ role: 'off' });
    expect(share.calls.at(-1)).toBe('deactivate');
    expect(service.config().port).toBe(5000);
    share.fire();
    expect(changes).toBe(4);
  });

  it('a failing activation (checks) keeps the old role and file', async () => {
    const { service, share, configure, readFileConfig } = await setup();
    await service.start();
    share.failNext = new CommandError(makeError('REMOTE_KEYSTORE_UNAVAILABLE'));
    const error = await commandError(configure({ role: 'share' }));
    expect(error.error.code).toBe('REMOTE_KEYSTORE_UNAVAILABLE');
    expect(service.config().role).toBe('off');
    expect(await readFileConfig()).toBeNull();
    expect(share.calls).toEqual(['prepare', 'activate:4713', 'deactivate']);
  });

  it('share ↔ control only without couplings of the other side – also via off (REMOTE_ROLE_CONFLICT)', async () => {
    const { service, share, control, configure } = await setup();
    await service.start();
    await configure({ role: 'share' });
    share.coupled = 1;
    expect((await commandError(configure({ role: 'control' }))).error).toEqual({
      code: 'REMOTE_ROLE_CONFLICT',
      params: { role: 'share' },
    });
    expect(service.config().role).toBe('share');
    await configure({ role: 'off' });
    expect((await commandError(configure({ role: 'control' }))).error.params).toEqual({ role: 'share' });
    share.coupled = 0;
    await configure({ role: 'control' });
    expect(control?.calls.at(-1)).toBe('activate:4713');
    if (control !== undefined) control.coupled = 2;
    expect((await commandError(configure({ role: 'share' }))).error.params).toEqual({ role: 'control' });
  });

  it('share → control directly: the old side is closed before the new one starts', async () => {
    const { service, share, control, configure } = await setup();
    await service.start();
    await configure({ role: 'share' });
    await configure({ role: 'control' });
    expect(share.calls.at(-1)).toBe('deactivate');
    expect(control?.calls.at(-1)).toBe('activate:4713');
  });

  it('a failed write restores the previous side', async () => {
    const control = { fail: false };
    const fs: FsOps = {
      ...nodeFsOps,
      writeFile: (file, data) =>
        control.fail ? Promise.reject(new Error('disk')) : nodeFsOps.writeFile(file, data),
    };
    const { service, share, control: controlSide, configure } = await setup({ fs });
    await service.start();
    await configure({ role: 'control' });
    control.fail = true;
    const error = await commandError(configure({ role: 'share' }));
    expect(error.error).toEqual({ code: 'STORE_WRITE_FAILED', params: { file: 'multi-host.json' } });
    expect(service.config().role).toBe('control');
    expect(share.calls.slice(-2)).toEqual(['activate:4713', 'deactivate']);
    expect(controlSide?.calls.slice(-1)).toEqual(['activate:4713']);
  });

  it('start activates the stored role; a failure is not fatal; stop deactivates', async () => {
    const { home, share, file } = await setup();
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, config: { role: 'share', port: 4800, bindAddress: '0.0.0.0' } }),
    );
    share.failNext = new CommandError(makeError('REMOTE_ACCESS_FAILED', { reason: 'port_in_use' }));
    const service = createMultiHostService({ home, share });
    await service.start();
    expect(service.config()).toEqual({ role: 'share', port: 4800, bindAddress: '0.0.0.0' });
    expect(share.calls).toEqual(['prepare', 'activate:4800']);
    await service.stop();
    expect(share.calls.at(-1)).toBe('deactivate');
  });

  it('without a controlling side `control` is refused', async () => {
    const { service, configure } = await setup({ control: false });
    await service.start();
    expect((await commandError(configure({ role: 'control' }))).error.code).toBe('NOT_IMPLEMENTED');
  });

  it('a file of a newer version: role off, nothing is written', async () => {
    const { home, share, file } = await setup();
    const text = JSON.stringify({ schemaVersion: 2, config: { role: 'share' } });
    await writeFile(file, text);
    const warnings: ErrorPayload[] = [];
    const service = createMultiHostService({
      home,
      share,
      warnings: {
        add: (warning) => {
          warnings.push(warning);
        },
      },
    });
    await service.start();
    expect(service.config().role).toBe('off');
    const error = await commandError(
      service.commands.handle({ name: 'multiHost.configure', role: 'share' }, ctx),
    );
    expect(error.error).toEqual({
      code: 'STORE_VERSION_TOO_NEW',
      params: { file: 'multi-host.json', version: 2, supported: 1 },
    });
    expect(warnings).toEqual([error.error]);
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(share.calls).toEqual(['prepare']);
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: TEST_HOST, port: 0 }, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  return port;
}

describe('role with the real sharing side', () => {
  it('switching to share runs the checks: without key store the role stays off; with it the listener runs', async () => {
    const home = await makeTempHome('wp78a-role-');
    const keyStore = createMemoryKeyStore({ available: false });
    const share: RemoteAccess = createRemoteAccessService({
      home,
      instance: testInstance(),
      hub: createFakeHub(),
      keyStore,
      limits: OPEN_LIMITS,
      firewall: () => Promise.resolve({ kind: 'no_rule' }),
      selfTest: () => Promise.resolve(null),
      detectAddresses: () => [],
      currentRole: () => service.config().role,
    });
    const service = createMultiHostService({ home, share });
    cleanups.push(() => share.close());
    await service.start();
    const port = await freePort();
    const refused = await commandError(
      service.commands.handle(
        { name: 'multiHost.configure', role: 'share', port, bindAddress: TEST_HOST },
        ctx,
      ),
    );
    expect(refused.error.code).toBe('REMOTE_KEYSTORE_UNAVAILABLE');
    expect(service.config().role).toBe('off');
    expect(share.state()).toBeNull();
    const conflict = await commandError(share.commands.handle({ name: 'remoteAccess.pair' }, ctx));
    expect(conflict.error).toEqual({ code: 'REMOTE_ROLE_CONFLICT', params: { role: 'off' } });

    keyStore.setAvailable(true);
    await service.commands.handle(
      { name: 'multiHost.configure', role: 'share', port, bindAddress: TEST_HOST },
      ctx,
    );
    expect(share.state()).toMatchObject({ listening: true, port });
    expect(share.state()?.checks.find((check) => check.id === 'firewall')?.status).toBe('warning');
    await service.stop();
    expect(share.state()).toBeNull();
  });
});
