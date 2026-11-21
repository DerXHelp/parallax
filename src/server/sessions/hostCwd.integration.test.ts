/**
 * WP-103: a session with a real `cwd` on this host – on Windows and on Linux alike. `startServer()`
 * in-process with the FakeBackend (temp PARALLAX_HOME, port 0, no signal handlers): `/api/health`
 * answers, `session.create` with a temp folder as `cwd` keeps the string exactly and the first turn
 * ends idle. The cwd checks follow the rules of the host: an unsafe, missing or non-folder cwd is
 * refused before any session exists.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { sampleId } from '@shared/samples';
import { startServer, type RunningServer } from '../app/compose';
import { loadConfig } from '../config';
import { makeTempHome } from '../http/testServer';
import { checkHealth } from '../launcher/client';
import { createMemoryKeyStore } from '../secure/memoryKeyStore';
import type { CommandContext } from '../sync/ports';
import { createFakeUpdateService } from '../update/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempHome(prefix);
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function start(home: string): Promise<RunningServer> {
  const config = loadConfig({
    argv: ['--backend=fake', '--port=0', `--home=${home}`, '--validate=throw'],
    env: {},
  });
  const server = await startServer({
    config,
    webRoot: null,
    signals: null,
    fakeSpeed: 0,
    exit: () => undefined,
    homeLock: null,
    updateService: createFakeUpdateService(),
    keyStore: createMemoryKeyStore(),
  });
  cleanups.push(() => server.shutdown.stop('command'));
  return server;
}

function ctx(): CommandContext {
  return { clientId: sampleId('cl', 1), cmdId: randomUUID() };
}

const prompt = (text: string) => ({ text, attachments: [], pastes: [] });

describe('a session with a real cwd on this host (WP-103)', () => {
  it('health answers; session.create keeps the temp cwd exactly and the first turn ends idle', async () => {
    const home = await tempDir('wp103-home-');
    const project = path.join(await tempDir('wp103-cwd-'), 'Project Ä');
    await mkdir(project);
    await writeFile(path.join(project, 'README.md'), '# Project\n');
    const server = await start(home);
    const { manager } = server;

    expect(await checkHealth(server.port)).toMatchObject({
      kind: 'ok',
      health: { serverInstanceId: server.instance.serverInstanceId },
    });
    expect(manager.hostState()).toMatchObject({ backend: 'fake', setupRequired: false });

    const created = await manager.handleCommand(
      { name: 'session.create', cwd: project, prompt: prompt('hello') },
      ctx(),
    );
    const entryId = (created as { entryId: EntryId }).entryId;
    const summary = () => manager.listSummaries().find((s) => s.entryId === entryId);
    await vi.waitFor(() => {
      expect(summary()?.status.runState).toBe('idle');
    });
    expect(summary()?.cwd).toBe(project);
    expect(summary()?.status.errorCode).toBeNull();
    const view = await manager.loadView(entryId);
    expect((view?.items ?? []).some((item) => item.kind === 'assistant_text')).toBe(true);
  });

  it('an unsafe, missing or non-folder cwd is refused before any session exists', async () => {
    const home = await tempDir('wp103-home-');
    const base = await tempDir('wp103-cwd-');
    const file = path.join(base, 'file.txt');
    await writeFile(file, 'x\n');
    const server = await start(home);
    const { manager } = server;

    const [unsafe, reason] =
      process.platform === 'win32' ? ['\\\\fake-host\\share\\repo', 'unc'] : ['/proc/self', 'pseudo_fs'];
    const create = (cwd: string) =>
      manager.handleCommand({ name: 'session.create', cwd, prompt: prompt('hello') }, ctx());
    await expect(create(unsafe)).rejects.toMatchObject({
      error: { code: 'PATH_REJECTED', params: { reason } },
    });
    await expect(create('relative/project')).rejects.toMatchObject({ error: { code: 'PATH_REJECTED' } });
    await expect(create(path.join(base, 'missing'))).rejects.toMatchObject({
      error: { code: 'CWD_NOT_FOUND' },
    });
    await expect(create(file)).rejects.toMatchObject({ error: { code: 'CWD_NOT_DIRECTORY' } });
    expect(manager.listSummaries()).toEqual([]);
  });
});
