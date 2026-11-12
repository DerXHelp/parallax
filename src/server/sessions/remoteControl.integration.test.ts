/**
 * WP-64 – Remote Control through the real manager with the FakeBackend (fake bridge, speed 0), the
 * memory stores and a virtual clock: the wish (`Entry.remoteControlWanted`) and its live state in the
 * summary, reattach after a close and a server restart (same link), the setting for new sessions
 * (follow_claude / on / off, host state), readable errors, no idle sleep while connected, turns typed
 * in the Claude app, approvals answered there, /clear and fresh context keep the bridge, archive and
 * remove end it first, the gates.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import { currentConversation, type Conversation, type Entry, type TranscriptItem } from '@shared/model';
import type { AgentSession, RemoteControlRequest } from '../backend/types';
import { createTestConsoleLauncher, TEST_CONSOLE_FIRST_PID } from './testing/consoleLauncher';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MINUTE = 60_000;
const FAKE_URL = /^https:\/\/claude\.ai\/code\/session_fake[0-9a-f]{20}$/;

const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(h.errors).toEqual([]);
  }
});

async function setup(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const h = await createEngineHarness(options);
  harnesses.push(h);
  return h;
}

async function restart(h: EngineHarness, next: Partial<EngineHarnessOptions> = {}): Promise<EngineHarness> {
  const index = harnesses.indexOf(h);
  if (index >= 0) harnesses.splice(index, 1);
  expect(h.errors).toEqual([]);
  const restarted = await h.restart(next);
  harnesses.push(restarted);
  return restarted;
}

async function untilIdle(h: EngineHarness, entryId: EntryId): Promise<void> {
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
}

async function idleEntry(h: EngineHarness, prompt = 'Reply with exactly: OK'): Promise<EntryId> {
  const entryId = await h.create(prompt);
  await untilIdle(h, entryId);
  return entryId;
}

function entryOf(h: EngineHarness, entryId: EntryId): Entry {
  const entry = h.stores.registry.get(entryId);
  if (entry === undefined) throw new Error('no entry');
  return entry;
}

function conversationOf(h: EngineHarness, entryId: EntryId): Conversation {
  return currentConversation(entryOf(h, entryId));
}

async function untilRemote(h: EngineHarness, entryId: EntryId, state: string): Promise<void> {
  await h.waitFor(() => h.summary(entryId).remoteControl.state === state);
  await h.settle();
}

async function connectedEntry(h: EngineHarness, prompt?: string): Promise<EntryId> {
  const entryId = await idleEntry(h, prompt);
  expect(await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: true })).toEqual({});
  await untilRemote(h, entryId, 'connected');
  return entryId;
}

/** setRemoteControl calls of every backend session of the entry (enabled + request). */
function remoteCalls(h: EngineHarness, entryId: EntryId): unknown[][] {
  return h
    .sessions(entryId)
    .flatMap((s) => s.controls.filter((c) => c.method === 'setRemoteControl').map((c) => c.args));
}

function remoteStates(h: EngineHarness, entryId: EntryId): string[] {
  const states = h.publisher.summaries
    .filter((s) => s.summary.entryId === entryId)
    .map((s) => s.summary.remoteControl.state);
  return states.filter((state, i) => i === 0 || states[i - 1] !== state);
}

function userItems(h: EngineHarness, entryId: EntryId): Extract<TranscriptItem, { kind: 'user_message' }>[] {
  return h.stores.transcripts
    .items(entryId, conversationOf(h, entryId).id)
    .flatMap((i) => (i.kind === 'user_message' ? [i] : []));
}

function pendingMs(h: EngineHarness): number[] {
  return h.timers.pending().map((t) => t.ms);
}

describe('Remote Control: switching (WP-64 §1.3)', () => {
  it('on while running: connecting → connected, bridge + link on the conversation, name = title', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    expect(h.summary(entryId).remoteControl).toEqual({ state: 'off', sessionUrl: null, error: null, wanted: false });

    await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: true });
    await untilRemote(h, entryId, 'connected');

    const summary = h.summary(entryId);
    expect(summary.remoteControl).toMatchObject({ state: 'connected', error: null, wanted: true });
    expect(summary.remoteControl.sessionUrl).toMatch(FAKE_URL);
    expect(remoteStates(h, entryId)).toEqual(['off', 'connecting', 'connected']);
    const bridge = h.session(entryId).remoteControl;
    expect(conversationOf(h, entryId)).toMatchObject({
      bridgeSessionId: bridge?.bridgeSessionId,
      sessionUrl: summary.remoteControl.sessionUrl,
    });
    expect(entryOf(h, entryId).remoteControlWanted).toBe(true);
    expect(remoteCalls(h, entryId)).toEqual([[true, { name: summary.title, reattachSessionId: null }]]);
  });

  it('off: the CLI switches off, the stored bridge is forgotten – the next on starts a new remote session', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    const first = conversationOf(h, entryId).bridgeSessionId;
    expect(first).not.toBeNull();

    await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: false });
    expect(h.summary(entryId).remoteControl).toEqual({ state: 'off', sessionUrl: null, error: null, wanted: false });
    expect(conversationOf(h, entryId)).toMatchObject({ bridgeSessionId: null, sessionUrl: null });
    expect(h.session(entryId).remoteControl).toBeNull();
    expect(remoteCalls(h, entryId).at(-1)).toEqual([false, { name: null, reattachSessionId: null }]);
    // Off twice: nothing more reaches the CLI.
    await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: false });
    expect(remoteCalls(h, entryId)).toHaveLength(2);

    await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: true });
    await untilRemote(h, entryId, 'connected');
    expect(conversationOf(h, entryId).bridgeSessionId).not.toBe(first);
  });

  it('close keeps the bridge (wish + link); the next start reattaches – same link', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    const { bridgeSessionId, sessionUrl } = conversationOf(h, entryId);

    await h.cmd({ name: 'session.close', entryId });
    await h.settle();
    // No live bridge without a process; the summary keeps the stored link of the wanted entry.
    expect(h.summary(entryId).remoteControl).toEqual({ state: 'off', sessionUrl, error: null, wanted: true });
    // close never switches the bridge off (keepSessionOnExit keeps the remote session).
    expect(remoteCalls(h, entryId)).toHaveLength(1);

    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    await untilRemote(h, entryId, 'connected');
    expect(h.sessions(entryId)).toHaveLength(2);
    expect(h.session(entryId).controls.filter((c) => c.method === 'setRemoteControl')).toEqual([
      { method: 'setRemoteControl', args: [true, { name: h.summary(entryId).title, reattachSessionId: bridgeSessionId }] },
    ]);
    expect(h.summary(entryId).remoteControl.sessionUrl).toBe(sessionUrl);
  });

  it('server restart: the wish survives, the dormant entry shows its link, the next start reattaches (same link)', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    const { bridgeSessionId, sessionUrl } = conversationOf(h, entryId);

    const next = await restart(h);
    expect(next.summary(entryId).remoteControl).toEqual({ state: 'off', sessionUrl, error: null, wanted: true });
    await next.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    await untilRemote(next, entryId, 'connected');
    expect(remoteCalls(next, entryId)).toEqual([
      [true, { name: next.summary(entryId).title, reattachSessionId: bridgeSessionId }],
    ]);
    expect(next.summary(entryId).remoteControl.sessionUrl).toBe(sessionUrl);
    expect(conversationOf(next, entryId).bridgeSessionId).toBe(bridgeSessionId);
  });

  it('dormant: the wish is saved at once, the bridge comes with the next start', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.close', entryId });
    await h.settle();

    await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: true });
    expect(h.sessions(entryId)).toHaveLength(1);
    expect(h.summary(entryId).remoteControl).toEqual({ state: 'off', sessionUrl: null, error: null, wanted: true });
    expect(entryOf(h, entryId).remoteControlWanted).toBe(true);

    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    await untilRemote(h, entryId, 'connected');
    expect(remoteCalls(h, entryId)).toEqual([[true, { name: h.summary(entryId).title, reattachSessionId: null }]]);
  });

  it('a failed reattach (REMOTE_CONTROL_FAILED) is tried once more without it – a new link', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    const old = conversationOf(h, entryId).bridgeSessionId;
    await h.cmd({ name: 'session.close', entryId });
    await h.settle();

    const start = h.backend.start.bind(h.backend);
    const requests: RemoteControlRequest[] = [];
    h.backend.start = (req) => {
      const agent: AgentSession = start(req);
      const enable = agent.setRemoteControl.bind(agent);
      agent.setRemoteControl = (enabled, request) => {
        requests.push(request);
        if (enabled && request.reattachSessionId !== null) {
          return Promise.resolve({
            ok: false,
            error: makeError('REMOTE_CONTROL_FAILED', { reason: 'remote_control_reattach', detail: 'gone' }),
          });
        }
        return enable(enabled, request);
      };
      return agent;
    };
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    await untilRemote(h, entryId, 'connected');
    expect(requests.map((r) => r.reattachSessionId)).toEqual([old, null]);
    const now = conversationOf(h, entryId);
    expect(now.bridgeSessionId).not.toBe(old);
    expect(h.summary(entryId).remoteControl.sessionUrl).toBe(now.sessionUrl);
  });

  it('gates: archived → SESSION_ARCHIVED; an entry in an external console → SESSION_EXTERNAL', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.setArchived', entryId, archived: true });
    expect(await h.cmdError({ name: 'session.setRemoteControl', entryId, enabled: true })).toEqual({
      code: 'SESSION_ARCHIVED',
      params: { entryId },
    });
    expect(entryOf(h, entryId).remoteControlWanted).toBe(false);

    const clock = { now: () => h.now() };
    const g = await setup({ consoleLauncher: createTestConsoleLauncher({ now: () => clock.now() }) });
    clock.now = () => g.now();
    const external = await idleEntry(g);
    expect(await g.cmd({ name: 'session.openExternal', entryId: external })).toEqual({ pid: TEST_CONSOLE_FIRST_PID });
    expect(await g.cmdError({ name: 'session.setRemoteControl', entryId: external, enabled: true })).toEqual({
      code: 'SESSION_EXTERNAL',
      params: { entryId: external },
    });
    expect(entryOf(g, external).remoteControlWanted).toBe(false);
  });
});

describe('Remote Control: new sessions and the Claude default (WP-64 §1.3)', () => {
  it('follow_claude (default): Claude says on → the first entry takes it after readiness, the next starts wanted', async () => {
    const h = await setup({ remoteControl: { atStartup: true } });
    expect(h.manager.hostState().remoteControlDefault).toBeNull();
    const first = await h.create('Reply with exactly: OK');
    await untilRemote(h, first, 'connected');
    expect(entryOf(h, first).remoteControlWanted).toBe(true);
    expect(h.manager.hostState().remoteControlDefault).toBe(true);
    expect(h.publisher.hostStates.at(-1)?.remoteControlDefault).toBe(true);

    const second = await h.create(null);
    expect(entryOf(h, second).remoteControlWanted).toBe(true);
  });

  it('follow_claude: Claude says off → not wanted, host state false', async () => {
    const h = await setup({ remoteControl: { atStartup: false } });
    const entryId = await idleEntry(h);
    expect(entryOf(h, entryId).remoteControlWanted).toBe(false);
    expect(h.summary(entryId).remoteControl.state).toBe('off');
    expect(h.manager.hostState().remoteControlDefault).toBe(false);
    expect(remoteCalls(h, entryId)).toEqual([]);
  });

  it('on / off ignore Claude; an explicit choice wins over follow_claude', async () => {
    const h = await setup({ remoteControl: { atStartup: true } });
    await h.cmd({ name: 'settings.update', patch: { remoteControl: { newSessions: 'off' } } });
    const off = await idleEntry(h);
    expect(entryOf(h, off).remoteControlWanted).toBe(false);
    expect(remoteCalls(h, off)).toEqual([]);

    await h.cmd({ name: 'settings.update', patch: { remoteControl: { newSessions: 'on' } } });
    const on = await h.create('Reply with exactly: OK');
    expect(entryOf(h, on).remoteControlWanted).toBe(true);
    await untilRemote(h, on, 'connected');

    // follow_claude, but switched off before readiness: Claude's default does not override it.
    await h.cmd({ name: 'settings.update', patch: { remoteControl: { newSessions: 'follow_claude' } } });
    const chosen = await h.create(null);
    expect(entryOf(h, chosen).remoteControlWanted).toBe(true);
    await h.cmd({ name: 'session.setRemoteControl', entryId: chosen, enabled: false });
    await h.cmd({ name: 'session.sendPrompt', entryId: chosen, prompt: { text: 'Reply with exactly: OK' } });
    await untilIdle(h, chosen);
    expect(entryOf(h, chosen).remoteControlWanted).toBe(false);
    expect(h.summary(chosen).remoteControl.state).toBe('off');
  });
});

describe('Remote Control: errors (WP-64 §1.3/§1.4)', () => {
  it.each([
    ['unavailable', makeError('REMOTE_CONTROL_UNAVAILABLE', { reason: 'sdk' })],
    ['auth', makeError('REMOTE_CONTROL_AUTH')],
    ['policy', makeError('REMOTE_CONTROL_POLICY_DISABLED')],
  ] as const)('enable %s → state failed with the error, the command succeeds, the wish stays', async (mode, error) => {
    const h = await setup({ remoteControl: { enable: mode } });
    const entryId = await idleEntry(h);
    expect(await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: true })).toEqual({});
    expect(h.summary(entryId).remoteControl).toEqual({ state: 'failed', sessionUrl: null, error, wanted: true });
    expect(conversationOf(h, entryId).bridgeSessionId).toBeNull();
    // Off clears the error.
    await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: false });
    expect(h.summary(entryId).remoteControl).toEqual({ state: 'off', sessionUrl: null, error: null, wanted: false });
  });

  it('fake:remote-fail (terminal) → failed REMOTE_CONTROL_FAILED; the idle sleep applies again', async () => {
    const h = await setup({ sleepPolicy: 'settings' });
    const entryId = await connectedEntry(h);
    expect(h.timers.pending()).toEqual([]);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:remote-fail' } });
    await untilRemote(h, entryId, 'failed');
    await untilIdle(h, entryId);
    expect(h.summary(entryId).remoteControl).toMatchObject({
      state: 'failed',
      error: { code: 'REMOTE_CONTROL_FAILED', params: { reason: 'terminal', detail: 'Remote Control session ended (fake)' } },
      wanted: true,
    });
    expect(pendingMs(h)).toEqual([30 * MINUTE]);
  });

  it('fake:remote-flaky: reconnecting, then connected again', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:remote-flaky' } });
    await untilIdle(h, entryId);
    await untilRemote(h, entryId, 'connected');
    expect(remoteStates(h, entryId)).toEqual(['off', 'connecting', 'connected', 'reconnecting', 'connected']);
  });

  it('the process crashes: live state off, the wish and the link stay', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    const { sessionUrl } = conversationOf(h, entryId);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:crash' } });
    await h.waitFor(() => h.session(entryId).state === 'exited');
    await h.settle();
    expect(h.summary(entryId).remoteControl).toEqual({ state: 'off', sessionUrl, error: null, wanted: true });
  });
});

describe('Remote Control: idle sleep (ADR-105 extended)', () => {
  it('no sleep while the bridge is up; off brings the sleep timer back', async () => {
    const h = await setup({ sleepPolicy: 'settings' });
    const entryId = await idleEntry(h);
    expect(pendingMs(h)).toEqual([30 * MINUTE]);
    await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: true });
    await untilRemote(h, entryId, 'connected');
    expect(h.timers.pending()).toEqual([]);
    h.timers.advance(120 * MINUTE);
    await h.settle();
    expect(h.facts(entryId).runState).toBe('idle');
    expect(h.session(entryId).state).not.toBe('exited');

    await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: false });
    expect(pendingMs(h)).toEqual([30 * MINUTE]);
    h.timers.advance(30 * MINUTE);
    await h.waitFor(() => h.facts(entryId).runState === 'sleeping');
  });
});

describe('Remote Control: turns from the Claude app (WP-64 §1.3)', () => {
  it('a prompt typed in the app: working → idle, user item source remote with its answer, cost counted, queue untouched', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    const costBefore = conversationOf(h, entryId).costUsd ?? 0;
    const summariesBefore = h.publisher.summaries.length;

    await h.session(entryId).remotePrompt('Hallo vom Handy', { totalCostUsd: costBefore + 0.004 });
    await untilIdle(h, entryId);

    const during = h.publisher.summaries.slice(summariesBefore).filter((s) => s.summary.entryId === entryId);
    expect(during.some((s) => s.summary.status.runState === 'working')).toBe(true);
    const users = userItems(h, entryId);
    expect(users.at(-1)).toMatchObject({ text: { text: 'Hallo vom Handy' }, source: 'remote', origin: 'human' });
    expect(users.filter((u) => u.source === 'remote')).toHaveLength(1);
    const texts = h.stores.transcripts
      .items(entryId, conversationOf(h, entryId).id)
      .flatMap((i) => (i.kind === 'assistant_text' ? [i.text] : []));
    expect(texts.at(-1)).toBe('From the app: Hallo vom Handy');
    expect(conversationOf(h, entryId).costUsd ?? 0).toBeGreaterThan(costBefore);
    expect((await h.manager.loadView(entryId))?.detail.queue).toEqual([]);
  });

  it('fake:remote-prompt: the own prompt appears once (its echo is dropped), then the app prompt with source remote', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:remote-prompt Wie spät ist es?' } });
    await untilIdle(h, entryId);
    const users = userItems(h, entryId).slice(-2);
    expect(users.map((u) => [u.text.text, u.source])).toEqual([
      ['fake:remote-prompt Wie spät ist es?', 'local'],
      ['Wie spät ist es?', 'remote'],
    ]);
    expect(userItems(h, entryId).filter((u) => u.text.text.startsWith('fake:remote-prompt'))).toHaveLength(1);
  });

  it('fake:remote-permission: the approval answered in the app → outcome answered_elsewhere, the tool ran', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:remote-permission' } });
    await untilIdle(h, entryId);
    const resolved = h.publisher.opsOf(entryId).filter((op) => op.op === 'decision.resolved');
    expect(resolved.at(-1)).toMatchObject({ outcome: { type: 'answered_elsewhere' }, byClientId: null });
    expect(h.facts(entryId).decisions.permission).toBe(0);
    const texts = h.stores.transcripts
      .items(entryId, conversationOf(h, entryId).id)
      .flatMap((i) => (i.kind === 'assistant_text' ? [i.text] : []));
    expect(texts.at(-1)).toBe('handy.txt was written (approved in the Claude app).');
  });

  it('a bridge that is not connected: the same abort stays cancelled (no false "answered in the app")', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    // The bridge starts over (ready → connecting): an abort now is not an answer from the app.
    h.session(entryId).bridgeState('ready');
    await untilRemote(h, entryId, 'connecting');
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:remote-permission' } });
    await untilIdle(h, entryId);
    const resolved = h.publisher.opsOf(entryId).filter((op) => op.op === 'decision.resolved');
    expect(resolved.at(-1)).toMatchObject({ outcome: { type: 'cancelled', reason: 'signal_aborted' } });
  });
});

describe('Remote Control: conversations, archive, remove (WP-64 §1.3)', () => {
  it('/clear: the new conversation keeps the bridge and the link (the process keeps its remote session)', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    const before = conversationOf(h, entryId);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: '/clear' } });
    await h.waitFor(() => h.publisher.opsOf(entryId).some((op) => op.op === 'conversation.reset'));
    await untilIdle(h, entryId);
    const after = conversationOf(h, entryId);
    expect(after.id).not.toBe(before.id);
    expect(after).toMatchObject({ bridgeSessionId: before.bridgeSessionId, sessionUrl: before.sessionUrl });
    expect(h.summary(entryId).remoteControl).toMatchObject({ state: 'connected', sessionUrl: before.sessionUrl });
    expect(remoteCalls(h, entryId)).toHaveLength(1);
  });

  it('approve_fresh_context: the new conversation of the new process reattaches to the same bridge', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    const before = conversationOf(h, entryId);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:plan' } });
    await h.waitFor(() => h.facts(entryId).decisions.plan === 1);
    await h.settle();
    const plan = (await h.decisions(entryId)).find((d) => d.kind === 'plan' && d.state === 'open');
    if (plan === undefined) throw new Error('no plan decision');
    await h.cmd({
      name: 'decision.respond',
      entryId,
      decisionId: plan.id,
      response: { kind: 'plan', response: { behavior: 'approve_fresh_context', mode: 'acceptEdits' } },
    });
    await h.waitFor(() => h.sessions(entryId).length === 2 && h.facts(entryId).runState === 'idle');
    await untilRemote(h, entryId, 'connected');
    const after = conversationOf(h, entryId);
    expect(after.id).not.toBe(before.id);
    expect(after).toMatchObject({ bridgeSessionId: before.bridgeSessionId, sessionUrl: before.sessionUrl });
    expect(h.session(entryId).controls.filter((c) => c.method === 'setRemoteControl').map((c) => c.args)).toEqual([
      [true, expect.objectContaining({ reattachSessionId: before.bridgeSessionId })],
    ]);
  });

  it('archive: the bridge is switched off before the process closes and forgotten; the wish stays', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    const handle = h.session(entryId);
    await h.cmd({ name: 'session.setArchived', entryId, archived: true });
    expect(handle.state).toBe('exited');
    expect(handle.controls.filter((c) => c.method === 'setRemoteControl').map((c) => c.args[0])).toEqual([
      true,
      false,
    ]);
    expect(conversationOf(h, entryId)).toMatchObject({ bridgeSessionId: null, sessionUrl: null });
    expect(h.summary(entryId).remoteControl).toEqual({ state: 'off', sessionUrl: null, error: null, wanted: true });
  });

  it('remove: the bridge is switched off before the process closes', async () => {
    const h = await setup();
    const entryId = await connectedEntry(h);
    const handle = h.session(entryId);
    await h.cmd({ name: 'session.remove', entryId });
    expect(handle.state).toBe('exited');
    expect(handle.controls.filter((c) => c.method === 'setRemoteControl').map((c) => c.args[0])).toEqual([
      true,
      false,
    ]);
    expect(handle.remoteControl).toBeNull();
  });
});
