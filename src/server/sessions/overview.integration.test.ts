/**
 * WP-65 – the overview through the real manager with the FakeBackend (speed 0), memory stores and
 * a virtual clock: live activity (CLI sentence with the fake bridge, fallback from the tool calls,
 * throttle) and turn summary (CLI / fallback, persisted), `lastSeenAt` (presence, prompts from the
 * Claude app, restart), generated titles (auto once per conversation, custom wins, `/clear`,
 * "generate again", the bridge gets `/rename`, missing method), background moves (`fake:long-bash`)
 * and the usage query (first round, interval, merge with rate-limit events, failures).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import type { ClientPresence } from '@shared/protocol';
import { sampleId, SAMPLE_TIME } from '@shared/samples';
import type { SessionActivity, ToolCallItem } from '@shared/model';
import { FAKE_LONG_BASH_MOVED, FAKE_SUMMARY_DETAIL, FAKE_SUMMARY_SENTENCES } from '../backend/fake/overview';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';
import { resetTitleLogForTests } from './titles';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const harnesses: EngineHarness[] = [];

afterEach(async () => {
  resetTitleLogForTests();
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

async function restart(h: EngineHarness): Promise<EngineHarness> {
  harnesses.splice(harnesses.indexOf(h), 1);
  const next = await h.restart();
  harnesses.push(next);
  return next;
}

async function untilIdle(h: EngineHarness, entryId: EntryId): Promise<void> {
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
}

async function idleEntry(h: EngineHarness, prompt = 'hello first world'): Promise<EntryId> {
  const entryId = await h.create(prompt);
  await untilIdle(h, entryId);
  return entryId;
}

async function prompt(h: EngineHarness, entryId: EntryId, text: string): Promise<void> {
  await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text } });
  await untilIdle(h, entryId);
}

async function connect(h: EngineHarness, entryId: EntryId): Promise<void> {
  await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: true });
  await h.waitFor(() => h.summary(entryId).remoteControl.state === 'connected');
  await h.settle();
}

/** Every published activity of the entry, consecutive duplicates folded. */
function activities(h: EngineHarness, entryId: EntryId): (SessionActivity | null)[] {
  const list = h.publisher.summaries.filter((s) => s.summary.entryId === entryId).map((s) => s.summary.activity);
  return list.filter((a, i) => i === 0 || JSON.stringify(list[i - 1]) !== JSON.stringify(a));
}

function titleCalls(h: EngineHarness, entryId: EntryId): unknown[][] {
  return h
    .sessions(entryId)
    .flatMap((s) => s.calls.filter((c) => c.fn === 'generateTitle').map((c) => c.args));
}

function sentTexts(h: EngineHarness, entryId: EntryId): string[] {
  return h.sessions(entryId).flatMap((s) =>
    s.sent.map((p) =>
      typeof p.content === 'string'
        ? p.content
        : p.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''),
    ),
  );
}

function viewer(entryId: EntryId | null, visible = true): ClientPresence {
  return {
    clientId: sampleId('cl', 1),
    presence: { focused: visible, visible, viewingEntryId: entryId, typing: false },
    lastFocusAt: new Date(SAMPLE_TIME),
    connectedAt: new Date(SAMPLE_TIME),
  };
}

function presence(h: EngineHarness, clients: ClientPresence[]): void {
  h.publisher.setPresence(clients);
  h.manager.onPresenceChanged(clients);
}

async function runningBash(h: EngineHarness, entryId: EntryId): Promise<ToolCallItem> {
  await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:long-bash' } });
  await h.waitFor(() => h.session(entryId).state === 'waiting-control');
  await h.settle();
  const view = await h.manager.loadView(entryId);
  const call = view?.items.find((i): i is ToolCallItem => i.kind === 'tool_call' && i.status === 'running');
  if (call === undefined) throw new Error('no running call');
  return call;
}

describe('live activity and turn summary (§1.1)', () => {
  it('without a bridge: the running tool call, then the first line of the answer as summary', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await prompt(h, entryId, 'fake:summary');
    const seen = activities(h, entryId);
    expect(seen).toContainEqual({ kind: 'thinking' });
    expect(seen.some((a) => a?.kind === 'tool' && a.tool === 'Read' && a.target?.endsWith('notes.md') === true)).toBe(true);
    expect(seen.some((a) => a?.kind === 'claude')).toBe(false);
    expect(h.summary(entryId).activity).toBeNull();
    expect(h.summary(entryId).turnSummary).toMatchObject({
      source: 'parallax',
      text: 'Summary: the fake project has three files and no open problems.',
      category: null,
      needsAction: false,
    });
  });

  it('with the fake bridge: the CLI sentences and its turn summary win; persisted over a restart', async () => {
    let h = await setup();
    const entryId = await idleEntry(h);
    await connect(h, entryId);
    await prompt(h, entryId, 'fake:summary');
    const seen = activities(h, entryId);
    for (const text of FAKE_SUMMARY_SENTENCES) expect(seen).toContainEqual({ kind: 'claude', text });
    const summary = { source: 'claude', text: FAKE_SUMMARY_DETAIL, category: 'completed', needsAction: false };
    expect(h.summary(entryId).turnSummary).toMatchObject(summary);
    h = await restart(h);
    expect(h.summary(entryId).turnSummary).toMatchObject(summary);
    expect(h.summary(entryId).activity).toBeNull();
  });

  it('a summary stays until the next turn; errors leave it alone', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    expect(h.summary(entryId).turnSummary?.text).toBe('Echo: hello first world');
    await prompt(h, entryId, 'fake:error');
    expect(h.summary(entryId).turnSummary?.text).toBe('Echo: hello first world');
  });

  it('throttle: a change within activityMinMs follows after the pause', async () => {
    const h = await setup({ options: { activityMinMs: 2_000 } });
    const entryId = await idleEntry(h);
    await runningBash(h, entryId);
    expect(h.summary(entryId).activity).toEqual({ kind: 'thinking' });
    h.timers.advance(2_000);
    await h.settle();
    expect(h.summary(entryId).activity).toEqual({ kind: 'tool', tool: 'Bash', target: 'Run the test suite' });
  });
});

describe('lastSeenAt (§1.2)', () => {
  it('set when a visible viewer leaves (not while watching), kept over a restart', async () => {
    let h = await setup();
    const entryId = await idleEntry(h);
    expect(h.summary(entryId).lastSeenAt).toBeNull();
    presence(h, [viewer(entryId)]);
    h.timers.advance(60_000);
    await prompt(h, entryId, 'second');
    expect(h.summary(entryId).lastSeenAt).toBeNull();
    const left = h.now().toISOString();
    presence(h, [viewer(null)]);
    await h.settle();
    expect(h.summary(entryId).lastSeenAt).toBe(left);
    h = await restart(h);
    expect(h.summary(entryId).lastSeenAt).toBe(left);
  });

  it('a prompt typed in the Claude app counts as seen at its time', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await connect(h, entryId);
    h.timers.advance(5_000);
    await h.session(entryId).remotePrompt('from the phone');
    await untilIdle(h, entryId);
    expect(h.summary(entryId).lastSeenAt).not.toBeNull();
  });
});

describe('generated titles (§1.3)', () => {
  it('after the first real turn: generateSessionTitle(persist) → titleSource ai, once per conversation', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    expect(h.summary(entryId)).toMatchObject({ title: 'Fake: hello first world', titleSource: 'ai' });
    await prompt(h, entryId, 'another prompt');
    const calls = titleCalls(h, entryId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([expect.stringMatching(/^hello first world\n\nEcho: hello first world/), { persist: true }]);
    // No /rename without a bridge.
    expect(sentTexts(h, entryId).some((t) => t.startsWith('/rename'))).toBe(false);
  });

  it('a custom title is never replaced; /clear starts a new conversation that is titled again', async () => {
    const h = await setup();
    const custom = await h.create('hello custom', { title: 'My own title' });
    await untilIdle(h, custom);
    expect(h.summary(custom)).toMatchObject({ title: 'My own title', titleSource: 'custom' });
    expect(titleCalls(h, custom)).toEqual([]);

    const entryId = await idleEntry(h, 'first topic here');
    await prompt(h, entryId, '/clear');
    await prompt(h, entryId, 'second topic here');
    expect(titleCalls(h, entryId)).toHaveLength(2);
    expect(h.summary(entryId).titleSource).toBe('ai');
  });

  it('"generate again": a new title (also over a custom one), sent on as /rename, its echo stays ai', async () => {
    const h = await setup();
    const entryId = await h.create('hello again', { title: 'Mine' });
    await untilIdle(h, entryId);
    expect(await h.cmd({ name: 'session.regenerateTitle', entryId })).toEqual({});
    await untilIdle(h, entryId);
    expect(h.summary(entryId)).toMatchObject({ title: 'Fake (new): hello again', titleSource: 'ai' });
    expect(titleCalls(h, entryId).at(-1)?.[1]).toEqual({ persist: false });
    expect(sentTexts(h, entryId)).toContain('/rename Fake (new): hello again');
  });

  it('"generate again" on a dormant session starts it first', async () => {
    let h = await setup();
    const entryId = await idleEntry(h, 'dormant topic');
    h = await restart(h);
    expect(h.sessions(entryId)).toHaveLength(0);
    await h.cmd({ name: 'session.regenerateTitle', entryId });
    expect(h.summary(entryId).title).toBe('Fake (new): dormant topic');
  });

  it('with an active bridge the auto title goes to the CLI as /rename (echo keeps ai)', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: true });
    await h.cmd({ name: 'session.resume', entryId });
    await h.waitFor(() => h.summary(entryId).remoteControl.state === 'connected');
    await prompt(h, entryId, 'bridged topic');
    await h.settle();
    expect(sentTexts(h, entryId)).toContain('/rename Fake: bridged topic');
    expect(h.summary(entryId)).toMatchObject({ title: 'Fake: bridged topic', titleSource: 'ai' });
  });

  it('method missing: the AI-title query stays the fallback; "generate again" → CLAUDE_CONTROL_FAILED', async () => {
    const h = await setup({ overview: { titles: 'unavailable' } });
    const entryId = await idleEntry(h);
    // The fake CLI's own AI title, read through getSessionInfo (C.6).
    await h.waitFor(() => h.summary(entryId).titleSource === 'ai');
    expect(h.summary(entryId).title).toBe('Fake: hello first world');
    expect(await h.cmdError({ name: 'session.regenerateTitle', entryId })).toMatchObject({
      code: 'CLAUDE_CONTROL_FAILED',
    });
  });

  it('archived entries refuse both new commands', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.setArchived', entryId, archived: true });
    expect((await h.cmdError({ name: 'session.regenerateTitle', entryId })).code).toBe('SESSION_ARCHIVED');
    expect((await h.cmdError({ name: 'session.backgroundTasks', entryId, toolUseId: null })).code).toBe(
      'SESSION_ARCHIVED',
    );
  });
});

describe('background moves (§1.5)', () => {
  it('a running Bash call moves to the background, the turn ends with the task', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const call = await runningBash(h, entryId);
    expect(await h.cmd({ name: 'session.backgroundTasks', entryId, toolUseId: call.toolUseId })).toEqual({});
    await h.waitFor(() => h.facts(entryId).lastTurn !== null && h.facts(entryId).runState !== 'working');
    await h.settle();
    const view = await h.manager.loadView(entryId);
    const moved = view?.items.find((i): i is ToolCallItem => i.kind === 'tool_call' && i.toolUseId === call.toolUseId);
    // Speed 0: the background task ends at once (completed) – it ran as a background task.
    expect(moved?.task).toMatchObject({ taskType: 'local_bash', isBackgrounded: true, status: 'completed' });
    expect(view?.items.some((i) => i.kind === 'assistant_text' && i.text === FAKE_LONG_BASH_MOVED)).toBe(true);
    expect(h.session(entryId).controls.filter((c) => c.method === 'backgroundTasks')).toEqual([
      { method: 'backgroundTasks', args: [call.toolUseId] },
    ]);
  });

  it('all at once (null); unknown call → TASK_NOT_FOUND; dormant → SESSION_NOT_RUNNING', async () => {
    let h = await setup();
    const entryId = await idleEntry(h);
    expect((await h.cmdError({ name: 'session.backgroundTasks', entryId, toolUseId: 'toolu_nope' })).code).toBe(
      'TASK_NOT_FOUND',
    );
    await runningBash(h, entryId);
    expect(await h.cmd({ name: 'session.backgroundTasks', entryId, toolUseId: null })).toEqual({});
    await h.waitFor(() => h.facts(entryId).runState !== 'working');
    h = await restart(h);
    expect((await h.cmdError({ name: 'session.backgroundTasks', entryId, toolUseId: null })).code).toBe(
      'SESSION_NOT_RUNNING',
    );
  });

  it('the CLI refuses → CLAUDE_CONTROL_FAILED', async () => {
    const h = await setup({ overview: { backgroundTasks: 'disabled' } });
    const entryId = await idleEntry(h);
    const call = await runningBash(h, entryId);
    expect(
      (await h.cmdError({ name: 'session.backgroundTasks', entryId, toolUseId: call.toolUseId })).code,
    ).toBe('CLAUDE_CONTROL_FAILED');
    await h.cmd({ name: 'session.interrupt', entryId });
  });
});

describe('usage query (§1.4)', () => {
  const usageOptions = { options: { usagePollMs: 300_000, usageFirstMs: 10_000 } } satisfies EngineHarnessOptions;

  function readUsageCalls(h: EngineHarness, entryId: EntryId): number {
    return h.sessions(entryId).flatMap((s) => s.calls.filter((c) => c.fn === 'readUsage')).length;
  }

  it('first round after the spawn, then every interval; the windows land in the account limits', async () => {
    const h = await setup(usageOptions);
    const entryId = await idleEntry(h);
    expect(readUsageCalls(h, entryId)).toBe(0);
    h.timers.advance(10_000);
    await h.settle();
    expect(readUsageCalls(h, entryId)).toBe(1);
    const limits = h.manager.hostState().accountLimits.standard;
    expect(limits?.windows.five_hour?.utilization).toBeCloseTo(0.08);
    expect(limits?.windows.seven_day?.utilization).toBeCloseTo(0.23);
    expect(Object.keys(limits?.windows ?? {}).sort()).toEqual(['five_hour', 'seven_day']);
    h.timers.advance(300_000);
    await h.settle();
    expect(readUsageCalls(h, entryId)).toBe(2);
  });

  it('agrees with rate-limit events (one unit); one session per profile', async () => {
    const h = await setup(usageOptions);
    const a = await idleEntry(h);
    const b = await idleEntry(h, 'second session');
    await prompt(h, a, 'fake:limit-warning');
    h.timers.advance(10_000);
    await h.settle();
    expect(readUsageCalls(h, a) + readUsageCalls(h, b)).toBe(1);
    const limits = h.manager.hostState().accountLimits.standard;
    expect(limits?.status).toBe('allowed_warning');
    expect(limits?.windows.seven_day?.utilization).toBeCloseTo(0.81);
    expect(limits?.windows.five_hour?.utilization).toBeCloseTo(0.12);
  });

  it('failures and API-key accounts leave the limits alone', async () => {
    const h = await setup({ ...usageOptions, overview: { usage: 'failed' } });
    const entryId = await idleEntry(h);
    h.timers.advance(10_000);
    await h.settle();
    expect(readUsageCalls(h, entryId)).toBe(1);
    expect(h.manager.hostState().accountLimits.standard).toBeUndefined();
  });
});
