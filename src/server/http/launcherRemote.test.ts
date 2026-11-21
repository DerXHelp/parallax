import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import { launcherRemoteResponseSchema } from '@shared/http';
import type { Command } from '@shared/protocol';
import { sampleHostState, sampleRemoteAccessState, sampleTime, sampleToken } from '@shared/samples';
import { createLogger } from '../lib/logger';
import { CommandError, type CommandContext } from '../sync/ports';
import { launcherRemoteCommand, registerLauncherRemoteRoute } from './launcherRemote';

const TOKEN = sampleToken(6);
const CODE = '4821-9930-1175';

interface World {
  app: FastifyInstance;
  calls: { cmd: Command; ctx: CommandContext }[];
  logs: string[];
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function world(handle?: (cmd: Command) => unknown): Promise<World> {
  const app = fastify({ logger: false });
  apps.push(app);
  const calls: World['calls'] = [];
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', destination: { write: (line: string) => logs.push(line) } });
  registerLauncherRemoteRoute(app, {
    auth: { verifyLauncherToken: (authorization) => authorization === `Bearer ${TOKEN}` },
    target: {
      hostState: () => sampleHostState({ remoteAccess: sampleRemoteAccessState() }),
      handleCommand: (cmd, ctx) => {
        calls.push({ cmd, ctx });
        try {
          return Promise.resolve(handle?.(cmd) ?? {});
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    },
    logger,
  });
  await app.ready();
  return { app, calls, logs };
}

function post(app: FastifyInstance, body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/launcher/remote',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

describe('POST /api/launcher/remote (WP-107)', () => {
  it('maps every action to the command of the settings page (status: none)', () => {
    expect(launcherRemoteCommand({ action: 'status' })).toBeNull();
    expect(launcherRemoteCommand({ action: 'enable' })).toEqual({
      name: 'multiHost.configure',
      role: 'share',
    });
    expect(launcherRemoteCommand({ action: 'disable' })).toEqual({
      name: 'multiHost.configure',
      role: 'off',
    });
    expect(launcherRemoteCommand({ action: 'pair', level: 'manage' })).toEqual({
      name: 'remoteAccess.pair',
      level: 'manage',
    });
    expect(launcherRemoteCommand({ action: 'cancel' })).toEqual({ name: 'remoteAccess.cancelPairing' });
    expect(launcherRemoteCommand({ action: 'unpair' })).toEqual({ name: 'remoteAccess.unpair' });
    expect(launcherRemoteCommand({ action: 'level', level: 'control' })).toEqual({
      name: 'remoteAccess.setPeerLevel',
      level: 'control',
    });
  });

  it('without the launcher token: 401, nothing runs; with a cookie: 403', async () => {
    const w = await world();
    const missing = await post(w.app, { action: 'unpair' }, { authorization: '' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ code: 'LAUNCHER_TOKEN_INVALID' });
    const wrong = await post(w.app, { action: 'unpair' }, { authorization: `Bearer ${sampleToken(7)}` });
    expect(wrong.statusCode).toBe(401);
    const browser = await post(w.app, { action: 'unpair' }, { cookie: 'parallax_4711=x' });
    expect(browser.statusCode).toBe(403);
    expect(browser.json()).toMatchObject({ code: 'ORIGIN_REJECTED' });
    expect(w.calls).toEqual([]);
  });

  it('a malformed body is VALIDATION_FAILED', async () => {
    const w = await world();
    const res = await post(w.app, { action: 'level', level: 'root' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(w.calls).toEqual([]);
  });

  it('status: the state, no command', async () => {
    const w = await world();
    const res = await post(w.app, { action: 'status' });
    expect(res.statusCode).toBe(200);
    expect(launcherRemoteResponseSchema.parse(res.json())).toEqual({
      remoteAccess: sampleRemoteAccessState(),
      code: null,
      expiresAt: null,
    });
    expect(w.calls).toEqual([]);
  });

  it('pair --level manage runs as the local user; the code only in the answer, never in the log', async () => {
    const w = await world((cmd) =>
      cmd.name === 'remoteAccess.pair'
        ? { code: CODE, expiresAt: sampleTime(), hostName: 'demo-server', addresses: [], port: 47_200 }
        : {},
    );
    const res = await post(w.app, { action: 'pair', level: 'manage' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code: CODE, expiresAt: sampleTime() });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.cmd).toEqual({ name: 'remoteAccess.pair', level: 'manage' });
    expect(w.calls[0]?.ctx.access).toBe('local');
    expect(w.calls[0]?.ctx.clientId).toMatch(/^cl_[0-9a-f]{32}$/);
    expect(w.logs.join('')).toContain('launcher remote action');
    expect(w.logs.join('')).not.toContain(CODE);
  });

  it('a refused command keeps its code and status; anything else is INTERNAL_ERROR', async () => {
    const refused = await world(() => {
      throw new CommandError(makeError('REMOTE_ROLE_CONFLICT'));
    });
    const res = await post(refused.app, { action: 'enable' });
    expect(res.json()).toMatchObject({ code: 'REMOTE_ROLE_CONFLICT' });
    expect(refused.calls[0]?.cmd).toEqual({ name: 'multiHost.configure', role: 'share' });
    const broken = await world(() => {
      throw new Error('boom');
    });
    const failed = await post(broken.app, { action: 'unpair' });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
    const badPair = await world(() => ({ code: 7 }));
    expect((await post(badPair.app, { action: 'pair' })).statusCode).toBe(500);
  });
});
