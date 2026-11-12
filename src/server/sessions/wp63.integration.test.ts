/**
 * WP-63 â€“ `session.remove` through the real manager with the FakeBackend, the memory stores and a
 * virtual clock: Parallax forgets the entry (registry, engine, every window via `summary.remove`),
 * a running process is closed first like `session.close` (also during a turn; open decisions end
 * with `process_exit`), nothing on disk is touched (transcript log, decisions, plan versions) and a
 * restart does not bring the entry back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { currentConversation } from '@shared/model';
import { sampleEntry, sampleId, sampleTime } from '@shared/samples';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

async function restart(h: EngineHarness): Promise<EngineHarness> {
  const index = harnesses.indexOf(h);
  if (index >= 0) harnesses.splice(index, 1);
  expect(h.errors).toEqual([]);
  const next = await h.restart();
  harnesses.push(next);
  return next;
}

async function idleEntry(h: EngineHarness, prompt = 'Reply with exactly: OK'): Promise<EntryId> {
  const entryId = await h.create(prompt);
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
  return entryId;
}

function conversationOf(h: EngineHarness, entryId: EntryId) {
  const entry = h.stores.registry.get(entryId);
  if (entry === undefined) throw new Error('no entry');
  return currentConversation(entry).id;
}

describe('session.remove (WP-63)', () => {
  it('idle with a process: closed first, then gone from registry, engine and every window; files stay; a restart keeps it gone', async () => {
    const h = await setup();
    const keep = await idleEntry(h);
    const entryId = await idleEntry(h);
    const conversationId = conversationOf(h, entryId);
    const itemsBefore = h.stores.transcripts.items(entryId, conversationId);
    expect(itemsBefore.length).toBeGreaterThan(0);
    const countBefore = h.manager.hostState().profiles.reduce((n, p) => n + p.entryCount, 0);

    expect(await h.cmd({ name: 'session.remove', entryId })).toEqual({});

    expect(h.sessions(entryId).every((s) => s.state === 'exited')).toBe(true);
    expect(h.publisher.removedSummaries).toEqual([entryId]);
    expect(h.publisher.summaryOf(entryId)).toBeNull();
    expect(h.stores.registry.get(entryId)).toBeUndefined();
    expect(h.manager.inspect(entryId)).toBeNull();
    expect(await h.manager.loadView(entryId)).toBeNull();
    expect(h.manager.listSummaries().map((s) => s.entryId)).toEqual([keep]);
    expect(h.publisher.cleared).toContain(entryId);
    expect(h.manager.hostState().profiles.reduce((n, p) => n + p.entryCount, 0)).toBe(countBefore - 1);
    // Nothing on disk is deleted: the transcript log is still there, unchanged.
    expect(h.stores.transcripts.items(entryId, conversationId)).toEqual(itemsBefore);

    // Every later command (also a second remove) answers ENTRY_NOT_FOUND; nothing new is published.
    const published = h.publisher.allOps.length;
    const summaries = h.publisher.summaries.length;
    for (const cmd of [
      { name: 'session.remove', entryId },
      { name: 'session.sendPrompt', entryId, prompt: { text: 'hi' } },
      { name: 'session.resume', entryId },
    ] as const) {
      expect([cmd.name, (await h.cmdError(cmd)).code]).toEqual([cmd.name, 'ENTRY_NOT_FOUND']);
    }
    await h.settle();
    expect(h.publisher.allOps.length).toBe(published);
    expect(h.publisher.summaries.slice(summaries).map((s) => s.summary.entryId)).not.toContain(entryId);
    expect(h.stores.registry.get(entryId)).toBeUndefined();
    expect(h.backend.starts).toHaveLength(2);

    const next = await restart(h);
    expect(next.manager.listSummaries().map((s) => s.entryId)).toEqual([keep]);
    expect(next.stores.registry.get(entryId)).toBeUndefined();
    expect(next.stores.transcripts.items(entryId, conversationId)).toEqual(itemsBefore);
  });

  it('during a turn with an open permission: the process is closed, the decision ends with process_exit (record kept)', async () => {
    const h = await setup();
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.settle();
    expect(h.summary(entryId).status.runState).not.toBe('idle');

    await h.cmd({ name: 'session.remove', entryId });

    expect(h.sessions(entryId).every((s) => s.state === 'exited')).toBe(true);
    expect(h.publisher.removedSummaries).toEqual([entryId]);
    expect(h.stores.registry.get(entryId)).toBeUndefined();
    const records = h.stores.decisions.records(entryId);
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toMatchObject({ type: 'cancelled', reason: 'process_exit' });
  });

  it('archived (dormant) entries can be removed â€“ "Clean up archive"', async () => {
    const archived = sampleEntry({
      id: sampleId('en', 63),
      archived: true,
      lastRunState: 'sleeping',
      continueAt: sampleTime(3600),
    });
    const other = sampleEntry({ id: sampleId('en', 64), archived: true, lastRunState: 'sleeping' });
    const h = await setup({ seed: { entries: [archived, other] } });
    await h.cmd({ name: 'session.remove', entryId: archived.id });
    expect(h.stores.registry.get(archived.id)).toBeUndefined();
    expect(h.stores.registry.get(other.id)).toBeDefined();
    expect(h.publisher.removedSummaries).toEqual([archived.id]);
    expect(h.backend.starts).toHaveLength(0);
    // No continue timer of the removed entry is left behind.
    expect(h.timers.pending()).toEqual([]);
  });

  it('a prompt that waited for the lifecycle lock never restarts a removed entry', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.close', entryId });
    const remove = h.cmd({ name: 'session.remove', entryId });
    const prompt = h.cmdError({ name: 'session.sendPrompt', entryId, prompt: { text: 'late' } });
    await remove;
    expect((await prompt).code).toBe('ENTRY_NOT_FOUND');
    expect(h.backend.starts).toHaveLength(1);
    expect(h.stores.registry.get(entryId)).toBeUndefined();
  });

  it('unknown entry â†’ ENTRY_NOT_FOUND', async () => {
    const h = await setup();
    expect(await h.cmdError({ name: 'session.remove', entryId: sampleId('en', 99) })).toEqual({
      code: 'ENTRY_NOT_FOUND',
      params: { entryId: sampleId('en', 99) },
    });
  });
});

describe('context gauge with the autocompact threshold (WP-63 §1.4)', () => {
  it('after the turn from getContextUsage; the estimate during the next turn keeps it', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    // FakeBackend: 200 000 window, autocompact at 167 000 (defaults.ts).
    expect(h.summary(entryId).context).toMatchObject({
      source: 'sdk',
      maxTokens: 200_000,
      autoCompactThreshold: 167_000,
      isAutoCompactEnabled: true,
    });
    expect(h.stores.registry.get(entryId)?.context?.autoCompactThreshold).toBe(167_000);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:bash' } });
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.settle();
    expect(h.summary(entryId).context).toMatchObject({
      source: 'estimate',
      autoCompactThreshold: 167_000,
      isAutoCompactEnabled: true,
    });
  });
});

describe('rate limits (WP-63 §1.2)', () => {
  it('fake:ratelimit: the warning only updates the limit bar, the rejection stays a notice', async () => {
    const h = await setup();
    const entryId = await h.create('fake:ratelimit');
    await h.waitFor(() => h.manager.hostState().accountLimits.standard?.status === 'rejected');
    await h.settle();
    const conversationId = conversationOf(h, entryId);
    const notices = h.stores.transcripts
      .items(entryId, conversationId)
      .flatMap((i) => (i.kind === 'system' && i.event === 'rate_limit' ? [i.info.status] : []));
    expect(notices).toEqual(['rejected']);
    const warned = h.publisher.allOps.some(
      ({ entryId: id, op }) =>
        id === entryId &&
        op.op === 'item.upsert' &&
        op.item.kind === 'system' &&
        op.item.event === 'rate_limit' &&
        op.item.info.status !== 'rejected',
    );
    expect(warned).toBe(false);
  });
});
