/**
 * WP-107 (docs/wp/WP-76.md §B.13): the level `manage` on the sharing side – bound to the pairing
 * window, changed locally either way and remotely only down, a change raises the coupling generation
 * (every socket ends, the old level never sends another command), the connection log names it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { REMOTE_PATHS } from '@shared/http';
import { remoteEventSchema } from '@shared/model';
import { WS_CLOSE } from '@shared/protocol';
import { nodeFsOps, type FsOps } from '../lib/fs';
import { generateIdentity } from '../secure/identity';
import { pairWithHost } from '../secure/pairingClient';
import { REMOTE_WS_CLIENT_OPTIONS, remoteVersionHeaders } from '../secure/pinnedAgent';
import { TEST_HOST } from '../secure/testKit';
import { CommandError, type CommandContext } from '../sync/ports';
import { PairingWindow } from './pairingWindow';
import { createPeerStore } from './peerStore';
import { TEST_VERSION, startHarness, type Harness } from './testKit';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function harness(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const started = await startHarness(options);
  harnesses.push(started);
  return started;
}

const LOCAL: CommandContext = { clientId: 'cl_00000000000000000000000000000001', cmdId: 'l' };
const remote = (access: 'control' | 'manage'): CommandContext => ({ ...LOCAL, cmdId: 'r', access });

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError)
      return `${error.error.code}:${String(error.error.params.reason ?? '')}`;
    throw error;
  }
  return 'ok';
}

type Paired = Awaited<ReturnType<Harness['pair']>>;

/** Pairs a controlling computer through a window opened with `level`. */
async function pairAt(h: Harness, level: 'control' | 'manage'): Promise<Paired> {
  const opened = (await h.command({ name: 'remoteAccess.pair', level })) as { code: string };
  const identity = generateIdentity('coupling:pc-b');
  const result = await pairWithHost({
    address: TEST_HOST,
    port: h.port(),
    code: opened.code,
    deviceName: 'PC-A',
    identity,
    appVersion: TEST_VERSION,
    timeoutMs: 5_000,
  });
  return { ...result, identity };
}

async function events(h: Harness): Promise<{ kind: string; detail?: string | null | undefined }[]> {
  const result = (await h.command({ name: 'remoteAccess.events', onlyRejected: false })) as {
    events: unknown[];
  };
  return result.events.map((event) => remoteEventSchema.parse(event));
}

async function openSocket(h: Harness, paired: Paired): Promise<WebSocket> {
  const ws = new WebSocket(`wss://${TEST_HOST}:${String(h.port())}${REMOTE_PATHS.ws}`, {
    agent: h.agent(paired),
    ...REMOTE_WS_CLIENT_OPTIONS,
    headers: remoteVersionHeaders(TEST_VERSION),
  });
  ws.on('error', () => undefined);
  await new Promise((resolve) => ws.once('open', resolve));
  return ws;
}

describe('pairing window level (§B.13)', () => {
  it('binds the level to the window; default control; a new window replaces the level', () => {
    const window = new PairingWindow({ now: () => new Date(0), windowMs: 60_000, onClose: () => undefined });
    const plain = window.open();
    expect(plain.level).toBe('control');
    expect(window.levelFor(plain.id)).toBe('control');
    const manage = window.open('manage');
    expect(window.current()?.level).toBe('manage');
    expect(window.levelFor(manage.id)).toBe('manage');
    expect(window.levelFor(plain.id)).toBeNull();
  });
});

describe('coupling level on the sharing side (§B.13)', () => {
  it('a window opened with manage couples at manage; the default stays control', async () => {
    const h = await harness();
    await pairAt(h, 'manage');
    expect(h.service.state()?.peer?.level).toBe('manage');
    const plain = await harness();
    await plain.pair();
    expect(plain.service.state()?.peer?.level).toBe('control');
  });

  it('pairing windows open only locally (never over remote access)', async () => {
    const h = await harness();
    expect(
      await refusal(
        h.service.commands.handle({ name: 'remoteAccess.pair', level: 'manage' }, remote('manage')),
      ),
    ).toBe('REMOTE_NOT_ALLOWED:');
    expect(
      await refusal(h.service.commands.handle({ name: 'remoteAccess.cancelPairing' }, remote('manage'))),
    ).toBe('REMOTE_NOT_ALLOWED:');
  });

  it('setPeerLevel: locally either way, the generation rises, sockets close with 4504, the log names it', async () => {
    const h = await harness();
    const paired = await h.pair();
    const ws = await openSocket(h, paired);
    const socket = h.hub.sockets[0]?.socket;
    expect(socket?.remote?.level()).toBe('control');
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    await h.service.commands.handle({ name: 'remoteAccess.setPeerLevel', level: 'manage' }, LOCAL);
    expect(h.service.state()?.peer?.level).toBe('manage');
    expect(h.hub.closed).toContain(WS_CLOSE.SERVER_RESTARTING);
    expect([WS_CLOSE.SERVER_RESTARTING, 1006]).toContain(await closed);
    // The socket of the old generation never runs anything again.
    expect(socket?.remote?.level()).toBeNull();
    // Connection rows (the closed socket) may land before or after it: look for the row itself.
    const levelRows = async () => (await events(h)).filter((row) => row.kind === 'level_changed');
    expect(await levelRows()).toMatchObject([{ kind: 'level_changed', detail: 'control>manage' }]);
    // A new socket carries the new level.
    await openSocket(h, paired);
    expect(h.hub.sockets.at(-1)?.socket.remote?.level()).toBe('manage');
    // The same level again is a no-op.
    await h.service.commands.handle({ name: 'remoteAccess.setPeerLevel', level: 'manage' }, LOCAL);
    expect(await levelRows()).toHaveLength(1);
  });

  it('remotely only manage → control; never up, never from control; no coupling → not_paired', async () => {
    const h = await harness();
    expect(
      await refusal(h.service.commands.handle({ name: 'remoteAccess.setPeerLevel', level: 'manage' }, LOCAL)),
    ).toBe('VALIDATION_FAILED:not_paired');
    await h.pair();
    expect(
      await refusal(
        h.service.commands.handle({ name: 'remoteAccess.setPeerLevel', level: 'manage' }, remote('control')),
      ),
    ).toBe('REMOTE_NOT_ALLOWED:');
    expect(
      await refusal(
        h.service.commands.handle({ name: 'remoteAccess.setPeerLevel', level: 'manage' }, remote('manage')),
      ),
    ).toBe('REMOTE_NOT_ALLOWED:');
    await h.service.commands.handle({ name: 'remoteAccess.setPeerLevel', level: 'manage' }, LOCAL);
    expect(
      await refusal(
        h.service.commands.handle({ name: 'remoteAccess.setPeerLevel', level: 'control' }, remote('control')),
      ),
    ).toBe('REMOTE_NOT_ALLOWED:');
    await h.service.commands.handle(
      { name: 'remoteAccess.setPeerLevel', level: 'control' },
      remote('manage'),
    );
    expect(h.service.state()?.peer?.level).toBe('control');
  });

  it('lowering that cannot be stored revokes the coupling (fail closed); raising keeps control', async () => {
    const control = { fail: false };
    const fs: FsOps = {
      ...nodeFsOps,
      writeFile: (file, data) =>
        control.fail ? Promise.reject(new Error('disk')) : nodeFsOps.writeFile(file, data),
    };
    const h0 = await harness({ activate: false });
    const peerStore = createPeerStore({ home: h0.home, fs, retryDelaysMs: [] });
    const h = await harness({ home: h0.home, peerStore });
    await h.pair();
    control.fail = true;
    expect(
      await refusal(h.service.commands.handle({ name: 'remoteAccess.setPeerLevel', level: 'manage' }, LOCAL)),
    ).toBe('REMOTE_ACCESS_FAILED:store');
    expect(h.service.state()?.peer?.level).toBe('control');
    control.fail = false;
    await h.service.commands.handle({ name: 'remoteAccess.setPeerLevel', level: 'manage' }, LOCAL);
    control.fail = true;
    expect(
      await refusal(
        h.service.commands.handle({ name: 'remoteAccess.setPeerLevel', level: 'control' }, LOCAL),
      ),
    ).toBe('REMOTE_ACCESS_FAILED:store');
    expect(h.service.state()?.peer ?? null).toBeNull();
  });

  it('commands of the coupled computer: manage commands and terminals land in the log (names only)', async () => {
    const h = await harness();
    const paired = await pairAt(h, 'manage');
    await openSocket(h, paired);
    const socket = h.hub.sockets[0]?.socket;
    socket?.remote?.executed?.('settings.update');
    socket?.remote?.executed?.('session.sendPrompt');
    socket?.remote?.executed?.('session.openInTerminal');
    const rows = await events(h);
    expect(rows.find((row) => row.kind === 'manage_command')).toMatchObject({ detail: 'settings.update' });
    expect(rows.some((row) => row.kind === 'terminal_opened')).toBe(true);
    expect(rows.some((row) => row.detail === 'session.sendPrompt')).toBe(false);
  });
});
