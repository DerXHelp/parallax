/**
 * `startServer()` in-process (FakeBackend speed 0, temp PARALLAX_HOME, port 0, no signal handlers,
 * `exit` recorded): lock file, static UI, shutdown hook, single instance (5), newer store (3),
 * port in use (4) with a complete cleanup; the Phase-2 wiring (WP-40): host state (port, system
 * integration), host commands over the persistent profile store, the system integration seam and
 * the fake console. The process view (tsx, real exit codes, WS flow) is in
 * `main.integration.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import type { HostWarning, Settings } from '@shared/model';
import { sampleId, sampleProfileInput, sampleTime } from '@shared/samples';
import { loadConfig } from '../config';
import { makeTempHome, rawRequest } from '../http/testServer';
import { checkHealth } from '../launcher/client';
import { SERVER_EXIT_CODES } from '../launcher/exitCodes';
import { readServerLock, serverLockPath } from '../launcher/lockFile';
import type { ServerShutdown, SignalTarget } from '../launcher/shutdown';
import { acquireHomeLock, type HomeLock } from '../lib/homeLock';
import { createLogger } from '../lib/logger';
import type { CommandContext } from '../sync/ports';
import type { SystemIntegration } from '../system/ports';
import { resumedSessionId, StartupError, startServer, type RunningServer } from './compose';
import { installCrashHandlers } from './crash';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempHome(): Promise<string> {
  const home = await makeTempHome('wp20a-compose-');
  cleanups.push(() => rm(home, { recursive: true, force: true, maxRetries: 5 }));
  return home;
}

interface Started {
  server: RunningServer;
  exits: number[];
}

async function start(
  home: string,
  options: {
    port?: number;
    webRoot?: string | null;
    homeLock?: HomeLock;
    homeAccess?: (home: string) => Promise<unknown>;
    signals?: SignalTarget;
    systemIntegration?: SystemIntegration;
  } = {},
): Promise<Started> {
  const exits: number[] = [];
  const config = loadConfig({
    argv: ['--backend=fake', `--port=${String(options.port ?? 0)}`, `--home=${home}`, '--validate=throw'],
    env: {},
  });
  const server = await startServer({
    config,
    webRoot: options.webRoot ?? null,
    signals: options.signals ?? null,
    fakeSpeed: 0,
    exit: (code) => exits.push(code),
    homeLock: options.homeLock ?? null,
    // No PowerShell in the in-process tests unless a test asks for the check.
    homeAccess: options.homeAccess ?? null,
    ...(options.systemIntegration === undefined ? {} : { systemIntegration: options.systemIntegration }),
  });
  cleanups.push(() => server.shutdown.stop('command'));
  return { server, exits };
}

async function startError(promise: Promise<unknown>): Promise<StartupError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof StartupError)) throw new Error(`expected a StartupError, got ${String(error)}`);
  return error;
}

describe('startServer (composition)', () => {
  it('listens, writes the lock file with the actual port, serves dist/web and shuts down in order', async () => {
    const home = await tempHome();
    const webRoot = path.join(home, 'web');
    await mkdir(webRoot);
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Parallax</title>');
    const { server, exits } = await start(home, { webRoot });

    expect(server.port).toBeGreaterThan(0);
    const lock = await readServerLock(home);
    expect(lock).toEqual({ kind: 'ok', lock: server.lock.lock });
    expect(server.lock.lock).toMatchObject({
      port: server.port,
      pid: process.pid,
      serverInstanceId: server.instance.serverInstanceId,
      launcherToken: server.auth.launcherToken,
    });
    expect(await checkHealth(server.port)).toMatchObject({
      kind: 'ok',
      health: { serverInstanceId: server.instance.serverInstanceId },
    });
    const page = await rawRequest(server.port, {
      method: 'GET',
      path: '/',
      headers: { host: `127.0.0.1:${String(server.port)}` },
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>Parallax</title>');
    expect(server.manager.hostState()).toMatchObject({ backend: 'fake', dev: false, setupRequired: false });

    await server.shutdown.stop('command');
    expect(exits).toEqual([SERVER_EXIT_CODES.ok]);
    expect(server.app.server.listening).toBe(false);
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
    // Commands after the shutdown are refused by the engine.
    await expect(server.manager.handleCommand({ name: 'server.shutdown' }, ctx())).rejects.toMatchObject({
      error: { code: 'SERVER_SHUTTING_DOWN' },
    });
  });

  it('releases the home lock of main.ts after the lock file; the access check runs after listen (R2-05/R2-13)', async () => {
    const home = await tempHome();
    const acquired = await acquireHomeLock(home);
    if (acquired.kind !== 'acquired') throw new Error('home lock busy');
    const order: string[] = [];
    const homeLock: HomeLock = {
      pipe: acquired.lock.pipe,
      exclusive: acquired.lock.exclusive,
      release: async () => {
        order.push(`homeLock (lock file ${(await readServerLock(home)).kind})`);
        await acquired.lock.release();
      },
    };
    const checked: string[] = [];
    const { server } = await start(home, {
      homeLock,
      homeAccess: async (checkedHome) => {
        // Only after listen: the lock file exists already.
        checked.push(`${checkedHome} (lock file ${(await readServerLock(checkedHome)).kind})`);
        order.push('homeAccess');
      },
    });
    await vi.waitFor(() => {
      expect(checked).toEqual([`${home} (lock file ok)`]);
    });
    if (process.platform === 'win32') expect((await acquireHomeLock(home)).kind).toBe('busy');

    await server.shutdown.stop('command');
    expect(order).toEqual(['homeAccess', 'homeLock (lock file missing)']);
    const again = await acquireHomeLock(home);
    expect(again.kind).toBe('acquired');
    if (again.kind === 'acquired') await again.lock.release();
  });

  it('a signal (SIGTERM, Ctrl+C) runs the same shutdown: exit 0, lock file gone (R3-17)', async () => {
    const home = await tempHome();
    const signals = new EventEmitter();
    const { server, exits } = await start(home, { signals });
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    expect(await checkHealth(server.port)).toMatchObject({ kind: 'ok', health: { backend: 'fake' } });
    signals.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(exits).toEqual([SERVER_EXIT_CODES.ok]);
    });
    expect(server.app.server.listening).toBe(false);
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
  });

  it('CR-10: an unexpected error during the start (after listen) ends the server in order, like main.ts wires it', async () => {
    const home = await tempHome();
    const target = new EventEmitter();
    const immediateExits: number[] = [];
    const exits: number[] = [];
    // The wiring of main.ts: the crash handler sees the frame as soon as startServer reports it.
    let running: RunningServer | null = null;
    let frame: ServerShutdown | null = null;
    const uninstall = installCrashHandlers({
      log: createLogger({ level: 'silent' }),
      shutdown: () => running?.shutdown ?? frame,
      exit: (code) => immediateExits.push(code),
      target,
    });
    cleanups.push(() => {
      uninstall();
      return Promise.resolve();
    });
    const config = loadConfig({
      argv: ['--backend=fake', '--port=0', `--home=${home}`, '--validate=throw', '--toasts=off'],
      env: {},
    });
    let lockAtCrash = false;
    running = await startServer({
      config,
      webRoot: null,
      signals: null,
      fakeSpeed: 0,
      exit: (code) => exits.push(code),
      homeLock: null,
      onShutdownFrame: (shutdown) => {
        frame = shutdown;
      },
      // Called after listen and the lock file, while startServer has not returned yet.
      homeAccess: (checkedHome) => {
        lockAtCrash = existsSync(serverLockPath(checkedHome));
        target.emit('unhandledRejection', new Error('boom during the start'));
        return Promise.resolve();
      },
    });
    const started = running;
    cleanups.push(() => started.shutdown.stop('command'));
    await vi.waitFor(() => {
      expect(exits).toEqual([SERVER_EXIT_CODES.failure]);
    });
    expect(lockAtCrash).toBe(true);
    expect(immediateExits).toEqual([]);
    expect(running.app.server.listening).toBe(false);
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
  });

  it('CR-10: a shutdown that began during the start is awaited by a failing step – no second cleanup', async () => {
    const home = await tempHome();
    const blocker: Server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => {
            resolve();
          });
        }),
    );
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('blocker not listening');
    let releases = 0;
    const homeLock: HomeLock = {
      pipe: null,
      exclusive: false,
      release: () => {
        releases += 1;
        return Promise.resolve();
      },
    };
    const exits: number[] = [];
    const config = loadConfig({
      argv: ['--backend=fake', `--port=${String(address.port)}`, `--home=${home}`, '--toasts=off'],
      env: {},
    });
    const error = await startError(
      startServer({
        config,
        webRoot: null,
        signals: null,
        fakeSpeed: 0,
        exit: (code) => exits.push(code),
        homeLock,
        homeAccess: null,
        // E.g. an unexpected error (crash handler) or a signal right before listen.
        onShutdownFrame: (shutdown) => {
          void shutdown.stop('error', SERVER_EXIT_CODES.failure);
        },
      }),
    );
    expect(error.exitCode).toBe(SERVER_EXIT_CODES.portInUse);
    expect(exits).toEqual([SERVER_EXIT_CODES.failure]);
    expect(releases).toBe(1);
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
  });

  it('refuses a second server on the same PARALLAX_HOME (exit code 5)', async () => {
    const home = await tempHome();
    const first = await start(home);
    const error = await startError(start(home));
    expect(error.exitCode).toBe(SERVER_EXIT_CODES.alreadyRunning);
    expect(error.message).toContain(`port ${String(first.server.port)}`);
    // The first server is untouched.
    expect(await readServerLock(home)).toMatchObject({ kind: 'ok', lock: { port: first.server.port } });
  });

  it('aborts with exit code 3 on a store of a newer Parallax and leaves the file unchanged', async () => {
    const home = await tempHome();
    const file = path.join(home, 'processes.json');
    const content = `${JSON.stringify({ schemaVersion: 7, records: [] })}\n`;
    await writeFile(file, content);
    const error = await startError(start(home));
    expect(error.exitCode).toBe(SERVER_EXIT_CODES.storeVersionTooNew);
    expect(error.message).toContain('processes.json was written by a newer Parallax');
    expect(await readFile(file, 'utf8')).toBe(content);
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
  });

  it('port in use → exit code 4, everything closed again (a new start on the same home works)', async () => {
    const home = await tempHome();
    const blocker: Server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => {
            resolve();
          });
        }),
    );
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('blocker not listening');

    const error = await startError(start(home, { port: address.port }));
    expect(error.exitCode).toBe(SERVER_EXIT_CODES.portInUse);
    expect(error.message).toContain('EADDRINUSE');
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });

    const again = await start(home);
    expect(await checkHealth(again.server.port)).toMatchObject({ kind: 'ok' });
  });

  it.each(['profiles.json', 'model-catalogs.json', 'account-limits.json'])(
    'aborts with exit code 3 on a %s of a newer Parallax (Phase-2 stores)',
    async (name) => {
      const home = await tempHome();
      const file = path.join(home, name);
      const content = `${JSON.stringify({ schemaVersion: 9, profiles: {} })}\n`;
      await writeFile(file, content);
      const error = await startError(start(home));
      expect(error.exitCode).toBe(SERVER_EXIT_CODES.storeVersionTooNew);
      expect(error.message).toContain(`${name} was written by a newer Parallax`);
      expect(await readFile(file, 'utf8')).toBe(content);
      expect(await readServerLock(home)).toEqual({ kind: 'missing' });
    },
  );
});

describe('startServer: Phase-2 wiring (WP-40)', () => {
  it('host state: actual port, no system integration; profile.* and fs.listDirectory reach their handlers', async () => {
    const home = await tempHome();
    const project = path.join(home, 'project');
    await mkdir(project);
    const { server } = await start(home);
    const { manager } = server;
    expect(manager.hostState()).toMatchObject({ port: server.port, systemIntegration: false });

    const saved = await manager.handleCommand({ name: 'profile.save', profile: sampleProfileInput() }, ctx());
    const profileId = (saved as { profileId: string }).profileId;
    expect(manager.hostState().profiles.map((p) => p.name)).toEqual(['Standard', 'Work']);
    // The fake integration reads the same store: "Profil testen" works for the new profile.
    expect(await manager.handleCommand({ name: 'profile.test', profileId }, ctx())).toMatchObject({
      claude: { state: 'ok' },
    });
    expect(manager.hostState().profiles.find((p) => p.id === profileId)?.claude.state).toBe('ok');

    // entryCount comes from the registry: a session of the profile protects it against deletion.
    await manager.handleCommand({ name: 'session.create', cwd: project, profileId }, ctx());
    await expect(manager.handleCommand({ name: 'profile.delete', profileId }, ctx())).rejects.toMatchObject({
      error: { code: 'PROFILE_IN_USE', params: { count: 1 } },
    });
    expect(await manager.handleCommand({ name: 'profile.get', profileId }, ctx())).toMatchObject({
      entryCount: 1,
    });
    expect(manager.hostState().profiles.find((p) => p.id === profileId)?.entryCount).toBe(1);

    const listing = await manager.handleCommand(
      { name: 'fs.listDirectory', path: home, showHidden: false },
      ctx(),
    );
    expect(listing).toMatchObject({ path: home });
    const entries = (listing as { entries: { name: string; kind: string }[] }).entries;
    expect(entries.map((entry) => `${entry.name}:${entry.kind}`)).toContain('project:directory');

    // The profile store is flushed and closed with the other stores.
    await server.shutdown.stop('command');
    const file: unknown = JSON.parse(await readFile(path.join(home, 'profiles.json'), 'utf8'));
    expect(file).toMatchObject({ profiles: [{ id: 'standard' }, { id: profileId, name: 'Work' }] });
  });

  it('a profile change reaches the engine (onProfileChanged → host state)', async () => {
    const home = await tempHome();
    const { server } = await start(home);
    const changed = vi.spyOn(server.manager, 'onProfileChanged');
    await server.manager.handleCommand({ name: 'profile.save', profile: sampleProfileInput() }, ctx());
    expect(changed).toHaveBeenCalled();
  });

  it('system integration: applied after listen and after every settings.update; warnings and changes reach the host state', async () => {
    const home = await tempHome();
    const applied: Settings[] = [];
    let warnings: HostWarning[] = [];
    const listeners = new Set<() => void>();
    const system: SystemIntegration = {
      available: true,
      apply: (settings) => {
        applied.push(settings);
        return Promise.resolve();
      },
      toastLaunchUri: () => null,
      warnings: () => warnings,
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const { server } = await start(home, { systemIntegration: system });
    expect(server.manager.hostState().systemIntegration).toBe(true);
    await vi.waitFor(() => {
      expect(applied).toHaveLength(1);
    });
    expect(applied[0]?.autostart).toEqual({ enabled: false, openWindow: true });

    await server.manager.handleCommand(
      { name: 'settings.update', patch: { autostart: { enabled: true, openWindow: false } } },
      ctx(),
    );
    await vi.waitFor(() => {
      expect(applied.at(-1)?.autostart).toEqual({ enabled: true, openWindow: false });
    });

    const publish = vi.spyOn(server.manager, 'publishHostState');
    warnings = [
      {
        id: 'system:autostart',
        error: makeError('AUTOSTART_FAILED', { reason: 'blocked' }),
        at: sampleTime(1),
      },
    ];
    for (const listener of listeners) listener();
    expect(publish).toHaveBeenCalled();
    expect(server.manager.hostState().warnings).toContainEqual(warnings[0]);
  });

  it('fake console: openExternal hands the session over; after it ended the console turn comes back', async () => {
    const home = await tempHome();
    const project = path.join(home, 'console');
    await mkdir(project);
    const { server } = await start(home);
    const { manager } = server;
    const created = await manager.handleCommand(
      { name: 'session.create', cwd: project, prompt: { text: 'hello', attachments: [] } },
      ctx(),
    );
    const entryId = (created as { entryId: EntryId }).entryId;
    const summary = () => manager.listSummaries().find((s) => s.entryId === entryId);
    await vi.waitFor(() => {
      expect(summary()?.status.runState).toBe('idle');
    });

    const opened = await manager.handleCommand({ name: 'session.openExternal', entryId }, ctx());
    expect((opened as { pid: number }).pid).toBeGreaterThanOrEqual(50_000);
    expect(summary()?.external).toMatchObject({ running: true });

    // Fake console: 1.5 s, then the engine's check (every 5 s) takes the session back.
    await vi.waitFor(
      () => {
        expect(summary()?.external).toBeNull();
      },
      { timeout: 20_000, interval: 200 },
    );
    expect(summary()?.status.runState).toBe('sleeping');
    const view = await manager.loadView(entryId);
    const texts = (view?.items ?? []).map((item) =>
      item.kind === 'system' && item.event === 'handoff'
        ? `handoff:${item.phase}:${String(item.importedItems)}`
        : item.kind === 'assistant_text'
          ? item.text
          : item.kind,
    );
    expect(texts).toContain('handoff:external:0');
    expect(texts.some((text) => text.startsWith('handoff:returned:') && !text.endsWith(':0'))).toBe(true);
  });

  it('resumedSessionId reads the id after --resume of a console spec', () => {
    expect(resumedSessionId(['--resume', 'abc'])).toBe('abc');
    expect(resumedSessionId(['--model', 'haiku', '--resume', 'x-1'])).toBe('x-1');
    expect(resumedSessionId(['--resume'])).toBeNull();
    expect(resumedSessionId([])).toBeNull();
  });
});

function ctx(): CommandContext {
  return { clientId: sampleId('cl', 1), cmdId: randomUUID() };
}
