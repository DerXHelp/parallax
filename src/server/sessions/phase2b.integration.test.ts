/**
 * WP-34 – the rest of Phase 2 in the engine through the real manager with the FakeBackend, memory
 * stores and a virtual clock: image attachments (ADR-103), "continue after the rate limit"
 * (ADR-112, incl. server restart within/after the grace period), the fields of native toasts
 * (click URI and silent, ADR-109) and the profile caches (ADR-102, `onProfileChanged`). Everything
 * published passes the hub-like validation of the memory publisher.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, type EntryId, type ProfileId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { ClaudeInstallStatus, Profile, TranscriptItem } from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import { sampleEntry, sampleId, sampleProfile, sampleTime } from '@shared/samples';
import type { NotificationKind } from '@shared/status';
import { FAKE_SHOT_PNG_BASE64 } from '../backend/fake/image';
import { profileSummary, uncheckedClaudeStatus, type MutableProfileStore } from '../claude/profiles';
import { CONTINUE_PROMPT } from './continuePlan';
import { HOST_STATE_DEBOUNCE_MS } from './manager';
import { FALLBACK_MODEL_CATALOG } from './models';
import type { NativeToasts, ToastShowOptions } from './nativeToasts';
import {
  HARNESS_CWD,
  createEngineHarness,
  type EngineHarness,
  type EngineHarnessOptions,
} from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PNG = Buffer.from(FAKE_SHOT_PNG_BASE64, 'base64');
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

async function idleEntry(
  h: EngineHarness,
  prompt = 'Reply with exactly: OK',
  extra: { profileId?: ProfileId } = {},
): Promise<EntryId> {
  const entryId = await h.create(prompt, extra);
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
  return entryId;
}

function upserts(h: EngineHarness, entryId: EntryId): TranscriptItem[] {
  return h.publisher.opsOf(entryId).flatMap((op: SessionOp) => (op.op === 'item.upsert' ? [op.item] : []));
}

function assistantTexts(h: EngineHarness, entryId: EntryId): string[] {
  return upserts(h, entryId).flatMap((i) => (i.kind === 'assistant_text' && !i.streaming ? [i.text] : []));
}

function userMessages(h: EngineHarness, entryId: EntryId) {
  return upserts(h, entryId).flatMap((i) => (i.kind === 'user_message' ? [i] : []));
}

function pendingMs(h: EngineHarness): number[] {
  return h.timers.pending().map((t) => t.ms);
}

function sentTexts(h: EngineHarness, entryId: EntryId): string[] {
  return h
    .sessions(entryId)
    .flatMap((s) => s.sent)
    .map((p) => p.content.map((c) => (c.type === 'text' ? c.text : `<${c.type}>`)).join('|'));
}

// =====================================================================================
// Image attachments (ADR-103)
// =====================================================================================

describe('image attachments (ADR-103)', () => {
  it('session.create: image first, then the text; user_message and queue carry the BlobRefs; title from the text', async () => {
    const h = await setup();
    const ref = h.stores.blobs.put(PNG, 'image/png', 'shot.png');
    const { entryId, messageUuid } = await h.cmd({
      name: 'session.create',
      cwd: HARNESS_CWD,
      prompt: { text: 'What is on the screenshot?', attachments: [{ blobId: ref.blobId }] },
    });
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(h.session(entryId).sent[0]?.content).toEqual([
      { type: 'image', mediaType: 'image/png', base64: FAKE_SHOT_PNG_BASE64 },
      { type: 'text', text: 'What is on the screenshot?' },
    ]);
    expect(userMessages(h, entryId)).toEqual([
      expect.objectContaining({ id: messageUuid, attachments: [ref] }) as TranscriptItem,
    ]);
    const queued = h.publisher
      .opsOf(entryId)
      .flatMap((op) => (op.op === 'detail.patch' && op.patch.queue !== undefined ? op.patch.queue : []));
    expect(queued[0]).toMatchObject({ messageUuid, attachments: [ref] });
    expect(assistantTexts(h, entryId)).toEqual(['Fake: received 1 image(s)']);
    // The first summary carries the prompt title (the fake CLI's AI title follows after the turn).
    expect(h.publisher.summaries.find((s) => s.summary.entryId === entryId)?.summary).toMatchObject({
      title: 'What is on the screenshot?',
      titleSource: 'prompt',
    });
  });

  it('session.sendPrompt: two images without text → only image blocks; the item carries both', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const title = h.summary(entryId).title;
    const a = h.stores.blobs.put(PNG, 'image/png', 'a.png');
    const b = h.stores.blobs.put(Buffer.concat([PNG, Buffer.from([0])]), 'image/webp', 'b.webp');
    const { messageUuid } = await h.cmd({
      name: 'session.sendPrompt',
      entryId,
      prompt: { text: '  ', attachments: [{ blobId: a.blobId }, { blobId: b.blobId }] },
    });
    await h.waitFor(() => assistantTexts(h, entryId).includes('Fake: received 2 image(s)'));
    expect(
      h
        .session(entryId)
        .sent.at(-1)
        ?.content.map((c) => [c.type, c.type === 'image' ? c.mediaType : null]),
    ).toEqual([
      ['image', 'image/png'],
      ['image', 'image/webp'],
    ]);
    expect(userMessages(h, entryId).find((i) => i.id === messageUuid)?.attachments).toEqual([a, b]);
    // An image-only prompt does not change the title.
    expect(h.summary(entryId).title).toBe(title);
  });

  it.each<[string, (h: EngineHarness) => { blobId: string; error: (blobId: string) => ErrorPayload }]>([
    [
      'missing → BLOB_NOT_FOUND',
      () => ({
        blobId: 'c'.repeat(64),
        error: (blobId) => ({ code: 'BLOB_NOT_FOUND', params: { blobId } }),
      }),
    ],
    [
      'no image type → UNSUPPORTED_MEDIA_TYPE',
      (h) => ({
        blobId: h.stores.blobs.put('plain text', 'text/plain').blobId,
        error: (blobId) => ({ code: 'UNSUPPORTED_MEDIA_TYPE', params: { blobId, mediaType: 'text/plain' } }),
      }),
    ],
    [
      'larger than LIMITS.imageBytes → PAYLOAD_TOO_LARGE',
      (h) => ({
        blobId: h.stores.blobs.put(Buffer.alloc(LIMITS.imageBytes + 1), 'image/png').blobId,
        error: (blobId) => ({
          code: 'PAYLOAD_TOO_LARGE',
          params: { blobId, bytes: LIMITS.imageBytes + 1, max: LIMITS.imageBytes },
        }),
      }),
    ],
  ])('%s – checked before any start or send (create and sendPrompt)', async (_name, make) => {
    const h = await setup();
    const { blobId, error } = make(h);
    const good = h.stores.blobs.put(PNG, 'image/png');
    const attachments = [{ blobId: good.blobId }, { blobId }];
    expect(
      await h.cmdError({ name: 'session.create', cwd: HARNESS_CWD, prompt: { text: 'x', attachments } }),
    ).toEqual(error(blobId));
    expect(h.manager.listSummaries()).toEqual([]);
    expect(h.backend.starts).toEqual([]);

    const dormant = await h.create(null);
    expect(
      await h.cmdError({ name: 'session.sendPrompt', entryId: dormant, prompt: { text: 'x', attachments } }),
    ).toEqual(error(blobId));
    expect(h.backend.starts).toEqual([]);

    const running = await idleEntry(h);
    const sent = h.session(running).sent.length;
    expect(
      (await h.cmdError({ name: 'session.sendPrompt', entryId: running, prompt: { text: 'x', attachments } }))
        .code,
    ).toBe(error(blobId).code);
    expect(h.session(running).sent).toHaveLength(sent);
    expect(h.manager.inspect(running)?.queue).toEqual([]);
  });
});

// =====================================================================================
// Continue after the rate limit (ADR-112)
// =====================================================================================

/** `fake:ratelimit` (resets 60 s after SAMPLE_TIME); the debounced host state is flushed (+1 s). */
async function rateLimited(h: EngineHarness): Promise<EntryId> {
  const entryId = await h.create('fake:ratelimit');
  await h.waitFor(() => h.facts(entryId).runState === 'idle' && h.facts(entryId).rateLimitedUntil !== null);
  await h.settle();
  h.timers.advance(HOST_STATE_DEBOUNCE_MS);
  return entryId;
}

describe('continue after the rate limit (ADR-112)', () => {
  it('planned at rateLimitedUntil (wakeupAt in the summary); due → resume + "continue" (next)', async () => {
    const h = await setup();
    const entryId = await rateLimited(h);
    const sessionId = h.summary(entryId).sessionId;
    const until = sampleTime(60);
    expect(h.facts(entryId).rateLimitedUntil).toBe(until);
    expect(await h.cmd({ name: 'session.continueAfterLimit', entryId, enabled: true })).toEqual({
      continueAt: until,
    });
    expect(h.stores.registry.get(entryId)?.continueAt).toBe(until);
    expect(h.summary(entryId).status.wakeupAt).toBe(until);
    expect(h.status(entryId).kind).toBe('rate-limited');
    const delay = Date.parse(until) - h.now().getTime();
    expect(pendingMs(h)).toEqual([delay]);
    expect(h.manager.inspect(entryId)?.continueScheduled).toBe(true);
    // Dormant meanwhile: the plan resumes the session.
    await h.cmd({ name: 'session.close', entryId });
    expect(h.summary(entryId).status.wakeupAt).toBe(until);
    h.timers.advance(delay - 1);
    await h.settle();
    expect(h.backend.starts).toHaveLength(1);
    h.timers.advance(1);
    await h.waitFor(() => h.backend.starts.length === 2 && h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(h.backend.starts[1]?.resumeSessionId).toBe(sessionId);
    expect(h.session(entryId).sent.at(-1)).toMatchObject({
      content: [{ type: 'text', text: CONTINUE_PROMPT }],
      priority: 'next',
    });
    expect(assistantTexts(h, entryId).at(-1)).toBe(`Echo: ${CONTINUE_PROMPT}`);
    expect(h.stores.registry.get(entryId)?.continueAt).toBeNull();
    expect(h.summary(entryId).status.wakeupAt).toBeNull();
    expect(h.manager.inspect(entryId)?.continueScheduled).toBe(false);
  });

  it('without a future limit: at once, to the running process (no second start)', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    expect(await h.cmd({ name: 'session.continueAfterLimit', entryId, enabled: true })).toEqual({
      continueAt: h.now().toISOString(),
    });
    await h.waitFor(() => assistantTexts(h, entryId).includes(`Echo: ${CONTINUE_PROMPT}`));
    expect(h.backend.starts).toHaveLength(1);
    expect(h.stores.registry.get(entryId)?.continueAt).toBeNull();
  });

  it('cancel (enabled:false), an own prompt and archiving drop the plan', async () => {
    const h = await setup();
    const entryId = await rateLimited(h);
    await h.cmd({ name: 'session.continueAfterLimit', entryId, enabled: true });
    expect(await h.cmd({ name: 'session.continueAfterLimit', entryId, enabled: false })).toEqual({
      continueAt: null,
    });
    expect(h.timers.pending()).toEqual([]);
    expect(h.stores.registry.get(entryId)?.continueAt).toBeNull();
    expect(h.facts(entryId).wakeupAt).toBeNull();

    await h.cmd({ name: 'session.continueAfterLimit', entryId, enabled: true });
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    expect(h.stores.registry.get(entryId)?.continueAt).toBeNull();
    expect(h.manager.inspect(entryId)?.continueScheduled).toBe(false);
    await h.waitFor(() => h.facts(entryId).runState === 'idle' && h.facts(entryId).queuedPrompts === 0);
    await h.settle();

    await h.cmd({ name: 'session.continueAfterLimit', entryId, enabled: true });
    expect(h.facts(entryId).wakeupAt).not.toBeNull();
    await h.cmd({ name: 'session.setArchived', entryId, archived: true });
    expect(h.stores.registry.get(entryId)).toMatchObject({ archived: true, continueAt: null });
    expect(h.facts(entryId).wakeupAt).toBeNull();
    expect(h.manager.inspect(entryId)?.continueScheduled).toBe(false);
    h.timers.advance(3_600_000);
    await h.settle();
    expect(sentTexts(h, entryId)).not.toContain(CONTINUE_PROMPT);
  });

  it('server start: future → timer, ≤ grace overdue → at once, older → dropped', async () => {
    const future = sampleEntry({ id: sampleId('en', 51), continueAt: sampleTime(600) });
    const overdue = sampleEntry({ id: sampleId('en', 52), continueAt: sampleTime(-30 * 60) });
    const stale = sampleEntry({ id: sampleId('en', 53), continueAt: sampleTime(-2 * 3600) });
    const h = await setup({ seed: { entries: [future, overdue, stale] } });
    expect(h.summary(future.id).status.wakeupAt).toBe(sampleTime(600));
    expect(h.manager.inspect(future.id)?.continueScheduled).toBe(true);
    expect(pendingMs(h)).toEqual([600_000]);
    await h.waitFor(() => sentTexts(h, overdue.id).includes(CONTINUE_PROMPT));
    expect(h.backend.starts.map((s) => s.entryId)).toEqual([overdue.id]);
    expect(h.backend.starts[0]?.resumeSessionId).toBe(overdue.conversations[0]?.sessionId);
    expect(h.stores.registry.get(stale.id)?.continueAt).toBeNull();
    expect(h.summary(stale.id).status.wakeupAt).toBeNull();
    h.timers.advance(600_000);
    await h.waitFor(() => sentTexts(h, future.id).includes(CONTINUE_PROMPT));
    expect(h.backend.starts.map((s) => s.entryId).sort()).toEqual([future.id, overdue.id].sort());
    expect(h.stores.registry.get(future.id)?.continueAt).toBeNull();
    expect(sentTexts(h, stale.id)).toEqual([]);
  });

  it('a plan survives a server restart (registry) and fires after it', async () => {
    const h = await setup();
    const entryId = await rateLimited(h);
    await h.cmd({ name: 'session.continueAfterLimit', entryId, enabled: true });
    harnesses.splice(harnesses.indexOf(h), 1);
    const next = await h.restart();
    harnesses.push(next);
    expect(next.summary(entryId).status.wakeupAt).toBe(sampleTime(60));
    next.timers.advance(60_000);
    await next.waitFor(() => sentTexts(next, entryId).includes(CONTINUE_PROMPT));
    expect(next.stores.registry.get(entryId)?.continueAt).toBeNull();
  });
});

// =====================================================================================
// Native toasts (ADR-109)
// =====================================================================================

interface Shown {
  entryId: string;
  kind: NotificationKind;
  title: string;
  options: ToastShowOptions | undefined;
}

function toastDouble(): { toasts: NativeToasts; shown: Shown[] } {
  const shown: Shown[] = [];
  return {
    shown,
    toasts: {
      available: () => true,
      show: (entryId, kind, title, options) => {
        shown.push({ entryId, kind, title, options });
      },
      clear: () => undefined,
      idle: () => Promise.resolve(),
    },
  };
}

describe('native toasts: click URI and silent (ADR-109)', () => {
  it('launchUri from the system integration, silent = the event sound is off (settings at toast time)', async () => {
    const { toasts, shown } = toastDouble();
    const h = await setup({ toasts, toastLaunchUri: (entryId) => `parallax://session/${entryId}` });
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.settle();
    expect(shown).toEqual([
      {
        entryId,
        kind: 'permission',
        title: 'fake:bash',
        options: { launchUri: `parallax://session/${entryId}`, silent: false },
      },
    ]);
    const notifications = h.stores.settings.get().notifications;
    await h.cmd({
      name: 'settings.update',
      patch: {
        notifications: {
          ...notifications,
          events: { ...notifications.events, done: { ...notifications.events.done, sound: false } },
        },
      },
    });
    const [decision] = await h.decisions(entryId);
    if (decision === undefined) throw new Error('no decision');
    await h.cmd({
      name: 'decision.respond',
      entryId,
      decisionId: decision.id,
      response: { kind: 'permission', response: { behavior: 'allow', remember: null, acceptEdits: false } },
    });
    await h.waitFor(() => shown.length === 2);
    expect(shown[1]).toMatchObject({ kind: 'done', options: { silent: true } });
  });

  it('without a protocol handler: launchUri null (a click only dismisses)', async () => {
    const { toasts, shown } = toastDouble();
    const h = await setup({ toasts });
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => shown.length === 1);
    expect(shown[0]).toMatchObject({ entryId, options: { launchUri: null, silent: false } });
  });
});

// =====================================================================================
// Profile caches (ADR-102)
// =====================================================================================

function mutableProfiles(initial: readonly Profile[]): MutableProfileStore & { set(list: Profile[]): void } {
  let list = [...initial];
  const statuses = new Map<ProfileId, ClaudeInstallStatus>();
  const status = (id: ProfileId): ClaudeInstallStatus => statuses.get(id) ?? uncheckedClaudeStatus();
  return {
    list: () => [...list],
    get: (id) => list.find((p) => p.id === id),
    getDefault: () => list.find((p) => p.isDefault) ?? sampleProfile(),
    summaries: () => list.map((p) => profileSummary(p, status(p.id))),
    setClaudeStatus: (id, s) => {
      statuses.set(id, s);
    },
    claudeStatus: status,
    set: (next) => {
      list = [...next];
    },
  };
}

describe('profile caches (ADR-102, onProfileChanged)', () => {
  const work = sampleProfile({ id: sampleId('pf', 7), name: 'Work', isDefault: false, builtin: false });
  const temp = sampleProfile({ id: sampleId('pf', 8), name: 'Temp', isDefault: false, builtin: false });

  it('a changed env drops the model catalog (memory, file, open view); rename/unchanged keep it', async () => {
    const store = mutableProfiles([sampleProfile(), work]);
    const h = await setup({ profileStore: store });
    const entryId = await idleEntry(h, 'Reply with exactly: OK', { profileId: work.id });
    expect(h.stores.catalogs.models()[work.id]).toBeDefined();
    // An open view keeps the mirror of the dormant entry.
    h.manager.onSubscribersChanged(entryId, 1);
    await h.cmd({ name: 'session.close', entryId });
    const fallback = FALLBACK_MODEL_CATALOG.options.map((o) => o.value);
    expect((await h.cmd({ name: 'session.refreshModels', entryId })).models.map((m) => m.value)).not.toEqual(
      fallback,
    );

    const hostStates = h.publisher.hostStates.length;
    h.manager.onProfileChanged(work.id);
    store.set([sampleProfile(), { ...work, name: 'Work (renamed)', color: 'green' }]);
    h.manager.onProfileChanged();
    expect(h.stores.catalogs.models()[work.id]).toBeDefined();
    expect(h.publisher.hostStates.length).toBe(hostStates + 2);
    expect(h.manager.hostState().profiles.find((p) => p.id === work.id)?.name).toBe('Work (renamed)');

    const opsBefore = h.publisher.opsOf(entryId).length;
    store.set([sampleProfile(), { ...work, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } }]);
    h.manager.onProfileChanged(work.id);
    expect(h.stores.catalogs.models()[work.id]).toBeUndefined();
    expect((await h.cmd({ name: 'session.refreshModels', entryId })).models.map((m) => m.value)).toEqual(
      fallback,
    );
    const patch = h.publisher
      .opsOf(entryId)
      .slice(opsBefore)
      .find((op) => op.op === 'detail.patch' && op.patch.models !== undefined);
    expect(patch?.op === 'detail.patch' ? patch.patch.models?.map((m) => m.value) : null).toEqual(fallback);
    // The standard profile was not touched; the next start of the entry fills the catalog again.
    await h.cmd({ name: 'session.resume', entryId });
    await h.waitFor(() => h.stores.catalogs.models()[work.id] !== undefined);
  });

  it('a deleted profile loses its catalog and its account limits (host state)', async () => {
    const store = mutableProfiles([sampleProfile(), temp]);
    const h = await setup({ profileStore: store });
    const entryId = await h.create('fake:ratelimit', { profileId: temp.id });
    await h.waitFor(() => h.facts(entryId).rateLimitedUntil !== null && h.facts(entryId).runState === 'idle');
    await h.settle();
    await h.waitFor(() => h.manager.hostState().accountLimits[temp.id] !== undefined);
    expect(h.stores.catalogs.limits()[temp.id]).toBeDefined();
    await h.cmd({ name: 'session.close', entryId });
    store.set([sampleProfile()]);
    h.manager.onProfileChanged(null);
    expect(h.manager.hostState().accountLimits[temp.id]).toBeUndefined();
    expect(h.stores.catalogs.limits()[temp.id]).toBeUndefined();
    expect(h.stores.catalogs.models()[temp.id]).toBeUndefined();
    expect(h.publisher.hostStates.at(-1)?.accountLimits[temp.id]).toBeUndefined();
  });
});
