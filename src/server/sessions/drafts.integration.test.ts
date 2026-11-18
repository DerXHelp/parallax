/**
 * WP-77 (ADR-210) – synchronized drafts in the engine through the real manager with the
 * FakeBackend, memory stores and a virtual clock: `session.setDraft` (rev, clientId, limit, pastes,
 * every entry state), `detail.patch {draft}` + `summary.hasDraft`, a sent prompt clears the draft it
 * was sent from, the stored draft in the loaded view and after a restart, removal deletes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, type EntryId } from '@shared/common';
import type { SessionOp } from '@shared/protocol';
import { sampleDraft, sampleEntry, sampleExternalHandoff, sampleId } from '@shared/samples';
import {
  HARNESS_CLIENT_ID,
  createEngineHarness,
  type EngineHarness,
  type EngineHarnessOptions,
} from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const OTHER_CLIENT = sampleId('cl', 2);
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
  harnesses.splice(harnesses.indexOf(h), 1);
  expect(h.errors).toEqual([]);
  const next = await h.restart();
  harnesses.push(next);
  return next;
}

/** The `draft` field of every `detail.patch` published for the entry, in order. */
function draftPatches(h: EngineHarness, entryId: EntryId) {
  return h.publisher
    .opsOf(entryId)
    .flatMap((op: SessionOp) =>
      op.op === 'detail.patch' && op.patch.draft !== undefined ? [op.patch.draft] : [],
    );
}

async function viewDraft(h: EngineHarness, entryId: EntryId) {
  return (await h.manager.loadView(entryId))?.detail.draft;
}

describe('session.setDraft (WP-77, ADR-210)', () => {
  it('stores the draft: rev counts, clientId = the writer, patch to every window, hasDraft', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    expect(h.summary(entryId).hasDraft).toBe(false);
    expect(await viewDraft(h, entryId)).toBeNull();

    const first = await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'Half' }, baseRev: null });
    expect(first).toEqual({ rev: 1 });
    const second = await h.cmd(
      { name: 'session.setDraft', entryId, draft: { text: 'Half written' }, baseRev: 1 },
      OTHER_CLIENT,
    );
    expect(second).toEqual({ rev: 2 });

    const expected = {
      text: 'Half written',
      pastes: [],
      rev: 2,
      updatedAt: h.now().toISOString(),
      clientId: OTHER_CLIENT,
    };
    expect(draftPatches(h, entryId)).toEqual([
      { text: 'Half', pastes: [], rev: 1, updatedAt: expected.updatedAt, clientId: HARNESS_CLIENT_ID },
      expected,
    ]);
    expect(h.summary(entryId).hasDraft).toBe(true);
    expect(h.publisher.summaryOf(entryId)?.hasDraft).toBe(true);
    expect(await viewDraft(h, entryId)).toEqual(expected);
    expect(h.stores.drafts.draft(entryId)).toEqual(expected);
  });

  it('null clears (rev null, patch null, hasDraft false); clearing nothing publishes nothing', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'x' }, baseRev: null });
    expect(await h.cmd({ name: 'session.setDraft', entryId, draft: null, baseRev: 1 })).toEqual({
      rev: null,
    });
    expect(await h.cmd({ name: 'session.setDraft', entryId, draft: null, baseRev: null })).toEqual({
      rev: null,
    });
    expect(draftPatches(h, entryId).map((d) => d?.rev ?? null)).toEqual([1, null]);
    expect(h.summary(entryId).hasDraft).toBe(false);
    expect(h.stores.drafts.draft(entryId)).toBeNull();
    // The rev keeps counting across the cleared draft (a window tells older from newer states).
    expect(await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'y' }, baseRev: null })).toEqual({
      rev: 2,
    });
  });

  it('the last writer wins: an outdated baseRev is never refused', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'a' }, baseRev: null });
    await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'b' }, baseRev: 1 }, OTHER_CLIENT);
    expect(await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'c' }, baseRev: 1 })).toEqual({
      rev: 3,
    });
    expect((await viewDraft(h, entryId))?.text).toBe('c');
  });

  it('pastes stand verbatim in the text; above LIMITS.draftTotalChars → DRAFT_TOO_LARGE', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    const paste = `${'line\n'.repeat(40)}end`;
    expect(
      await h.cmd({
        name: 'session.setDraft',
        entryId,
        draft: { text: `see ${paste} please`, pastes: [paste] },
        baseRev: null,
      }),
    ).toEqual({ rev: 1 });
    expect((await viewDraft(h, entryId))?.pastes).toEqual([paste]);
    expect(
      await h.cmdError({
        name: 'session.setDraft',
        entryId,
        draft: { text: 'no paste here', pastes: [paste] },
        baseRev: 1,
      }),
    ).toMatchObject({ code: 'VALIDATION_FAILED', params: { reason: 'paste_not_in_text', index: 0 } });

    const big = 'p'.repeat(LIMITS.promptChars);
    const pastes = Array.from({ length: 5 }, (_, i) => `${String(i)}${big.slice(1)}`);
    const error = await h.cmdError({
      name: 'session.setDraft',
      entryId,
      draft: { text: 'x', pastes },
      baseRev: 1,
    });
    expect(error).toMatchObject({
      code: 'DRAFT_TOO_LARGE',
      params: { chars: LIMITS.draftTotalChars + 1, max: LIMITS.draftTotalChars },
    });
    // Refused drafts change nothing.
    expect((await viewDraft(h, entryId))?.rev).toBe(1);
    expect(draftPatches(h, entryId)).toHaveLength(1);
  });

  it('is allowed for dormant, archived and external entries (no process starts)', async () => {
    const archived = sampleEntry({ id: sampleId('en', 71), archived: true, lastRunState: 'sleeping' });
    const external = sampleEntry({
      id: sampleId('en', 72),
      external: sampleExternalHandoff(),
      lastRunState: 'external',
    });
    const dormant = sampleEntry({ id: sampleId('en', 73), lastRunState: 'sleeping' });
    const h = await setup({ seed: { entries: [archived, external, dormant] } });
    for (const entry of [archived, external, dormant]) {
      expect(
        await h.cmd({ name: 'session.setDraft', entryId: entry.id, draft: { text: 'later' }, baseRev: null }),
      ).toEqual({ rev: 1 });
      expect(h.summary(entry.id).hasDraft).toBe(true);
      expect(h.sessions(entry.id)).toEqual([]);
    }
  });

  it('an unknown entry → ENTRY_NOT_FOUND', async () => {
    const h = await setup();
    expect(
      await h.cmdError({ name: 'session.setDraft', entryId: sampleId('en', 99), draft: null, baseRev: null }),
    ).toMatchObject({ code: 'ENTRY_NOT_FOUND' });
  });
});

describe('sending clears the draft (ADR-210)', () => {
  it('session.sendPrompt clears the draft everywhere once the prompt went out', async () => {
    const h = await setup();
    const entryId = await h.create();
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'Next question' }, baseRev: null });
    await h.cmd({
      name: 'session.sendPrompt',
      entryId,
      prompt: { text: 'Next question' },
      priority: 'next',
    });
    expect(draftPatches(h, entryId).map((d) => d?.rev ?? null)).toEqual([1, null]);
    expect(h.summary(entryId).hasDraft).toBe(false);
    expect(h.stores.drafts.draft(entryId)).toBeNull();
    expect(await viewDraft(h, entryId)).toBeNull();
    await h.settle();
  });

  it('a draft written while the prompt waited (dormant start) stays', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'first' }, baseRev: null });
    const sending = h.cmd({
      name: 'session.sendPrompt',
      entryId,
      prompt: { text: 'first' },
      priority: 'next',
    });
    // The window typed on before the dormant session was started and the prompt delivered.
    const typed = h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'second' }, baseRev: null });
    await Promise.all([sending, typed]);
    expect((await viewDraft(h, entryId))?.text).toBe('second');
    expect(h.summary(entryId).hasDraft).toBe(true);
    await h.settle();
  });

  it('a failed send keeps the draft', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'keep me' }, baseRev: null });
    const error = await h.cmdError({
      name: 'session.sendPrompt',
      entryId,
      prompt: { text: 'keep me', attachments: [{ blobId: 'f'.repeat(64) }] },
      priority: 'next',
    });
    expect(error.code).toBe('BLOB_NOT_FOUND');
    expect((await viewDraft(h, entryId))?.text).toBe('keep me');
  });
});

describe('stored drafts (WP-77)', () => {
  it('the loaded view and the first summary carry the stored draft', async () => {
    const entry = sampleEntry({ lastRunState: 'sleeping' });
    const draft = sampleDraft({ rev: 4 });
    const h = await setup({ seed: { entries: [entry], drafts: [{ entryId: entry.id, draft }] } });
    expect(h.summary(entry.id).hasDraft).toBe(true);
    expect(await viewDraft(h, entry.id)).toEqual(draft);
    // The rev goes on from the stored one.
    expect(
      await h.cmd({ name: 'session.setDraft', entryId: entry.id, draft: { text: 'more' }, baseRev: 4 }),
    ).toEqual({ rev: 5 });
  });

  it('survives a restart; the shutdown flushes the store', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'over night' }, baseRev: null });
    const flushes = h.stores.drafts.flushes;
    const next = await restart(h);
    expect(next.stores.drafts.flushes).toBeGreaterThan(flushes);
    expect(next.summary(entryId).hasDraft).toBe(true);
    expect((await viewDraft(next, entryId))?.text).toBe('over night');
  });

  it('session.remove deletes the draft of the entry', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'gone' }, baseRev: null });
    await h.cmd({ name: 'session.remove', entryId });
    expect(h.stores.drafts.removed).toEqual([entryId]);
    expect(h.stores.drafts.draft(entryId)).toBeNull();
  });

  it('without a draft store the engine keeps drafts in memory', async () => {
    const h = await setup({ drafts: false });
    const entryId = await h.create(null);
    expect(await h.cmd({ name: 'session.setDraft', entryId, draft: { text: 'm' }, baseRev: null })).toEqual({
      rev: 1,
    });
    expect(h.summary(entryId).hasDraft).toBe(true);
    expect(h.stores.drafts.saves).toEqual([]);
  });
});
