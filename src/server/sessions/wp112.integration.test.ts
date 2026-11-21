/**
 * WP-112 through the engine (SessionManager + FakeBackend + memory stores): the unread mark of
 * `session.setUnread` (unread.ts), muted projects (notifier), pinned sessions that never sleep, and
 * MCP elicitations as decisions (broker, FakeBackend scenarios elicitation-form/-url/-unsupported).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import type { ElicitationDecision } from '@shared/model';
import { SAMPLE_TIME, sampleId, sampleNotificationSettings } from '@shared/samples';
import { eventsScenario } from '../backend/fakeBackend';
import { ELICITATION_FORM_CONTENT } from '../backend/fake/elicitation-form';
import { FAKE_SCENARIOS } from '../backend/fake/synthetic';
import type { ClientPresence } from '../sync/ports';
import {
  HARNESS_CWD,
  createEngineHarness,
  type EngineHarness,
  type EngineHarnessOptions,
} from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MINUTE = 60_000;
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

function client(entryId: EntryId | null, o: Partial<ClientPresence['presence']> = {}, n = 1): ClientPresence {
  return {
    clientId: sampleId('cl', n),
    presence: { focused: true, visible: true, viewingEntryId: entryId, typing: false, ...o },
    lastFocusAt: new Date(Date.parse(SAMPLE_TIME) + n),
    connectedAt: new Date(SAMPLE_TIME),
  };
}

/** A window in the background (not focused, not visible): notifications go there as `system`. */
const away = (n = 1): ClientPresence => client(null, { focused: false, visible: false }, n);

function setPresence(h: EngineHarness, list: ClientPresence[]): void {
  h.publisher.setPresence(list);
  h.manager.onPresenceChanged(list);
}

async function idleEntry(h: EngineHarness, prompt = 'Reply with exactly: OK'): Promise<EntryId> {
  const entryId = await h.create(prompt);
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
  return entryId;
}

function scenario(name: string) {
  const events = FAKE_SCENARIOS[name];
  if (events === undefined) throw new Error(`scenario ${name} missing`);
  return () => eventsScenario(name, events);
}

async function openElicitation(h: EngineHarness, entryId: EntryId): Promise<ElicitationDecision> {
  await h.waitFor(() => h.facts(entryId).decisions.elicitation === 1);
  const decision = (await h.decisions(entryId)).find((d) => d.kind === 'elicitation');
  if (decision?.kind !== 'elicitation') throw new Error('no elicitation decision');
  return decision;
}

function outcomes(h: EngineHarness, entryId: EntryId) {
  return h.publisher.opsOf(entryId).flatMap((op) => (op.op === 'decision.resolved' ? [op] : []));
}

describe('session.setUnread (F6)', () => {
  it('the mark stays while the window that marked it shows the session, also when hidden and shown', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    setPresence(h, [client(entryId)]);
    expect(h.facts(entryId).unread).toBe(false);

    await h.cmd({ name: 'session.setUnread', entryId, unread: true });
    expect(h.facts(entryId).unread).toBe(true);
    setPresence(h, [client(entryId, { typing: true })]);
    setPresence(h, [client(entryId, { visible: false, focused: false })]);
    setPresence(h, [client(entryId)]);
    expect(h.facts(entryId).unread).toBe(true);

    // Switching to another session and back opens it anew: the mark ends, its hints are cleared.
    setPresence(h, [client(null)]);
    expect(h.facts(entryId).unread).toBe(true);
    const clearedBefore = h.publisher.cleared.length;
    setPresence(h, [client(entryId)]);
    expect(h.facts(entryId).unread).toBe(false);
    expect(h.publisher.cleared.slice(clearedBefore)).toContain(entryId);
  });

  it('another window that opens the session ends the mark', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    setPresence(h, [client(entryId, {}, 1), client(null, {}, 2)]);
    await h.cmd({ name: 'session.setUnread', entryId, unread: true });
    setPresence(h, [client(entryId, {}, 1), client(entryId, { focused: false }, 2)]);
    expect(h.facts(entryId).unread).toBe(false);
  });

  it('a mark without any viewer ends with the first visible viewer', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    setPresence(h, [client(entryId)]);
    setPresence(h, [client(null)]);
    await h.cmd({ name: 'session.setUnread', entryId, unread: true });
    setPresence(h, [client(null, { typing: true })]);
    expect(h.facts(entryId).unread).toBe(true);
    setPresence(h, [client(entryId)]);
    expect(h.facts(entryId).unread).toBe(false);
  });

  it('unread false marks it read and clears its notifications', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    expect(h.facts(entryId).unread).toBe(true);
    await h.cmd({ name: 'session.setUnread', entryId, unread: false });
    expect(h.facts(entryId).unread).toBe(false);
    expect(h.publisher.cleared).toContain(entryId);
  });
});

describe('muted projects (F6)', () => {
  it('a session of a muted project gets no notification; status and counters stay', async () => {
    const h = await setup({ presence: [away()] });
    h.stores.settings.update({ notifications: sampleNotificationSettings({ mutedProjects: [HARNESS_CWD] }) });
    setPresence(h, [away()]);
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.settle();
    expect(h.status(entryId).kind).toBe('needs-permission');
    expect(h.publisher.notifications).toEqual([]);
  });

  it('control: without the mute the same permission is notified', async () => {
    const h = await setup({ presence: [away()] });
    setPresence(h, [away()]);
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.settle();
    expect(h.publisher.notifications.map((n) => n.notification.kind)).toEqual(['permission']);
  });
});

describe('pinned sessions never sleep (F6, ADR-105)', () => {
  it('pinning drops the planned idle sleep, unpinning plans it again', async () => {
    const h = await setup({ sleepPolicy: 'settings' });
    const entryId = await idleEntry(h);
    expect(h.timers.pending().map((t) => t.ms)).toEqual([30 * MINUTE]);
    await h.cmd({ name: 'session.setPinned', entryId, pinned: true });
    expect(h.timers.pending()).toEqual([]);
    h.timers.advance(120 * MINUTE);
    await h.settle();
    expect(h.facts(entryId).runState).toBe('idle');
    await h.cmd({ name: 'session.setPinned', entryId, pinned: false });
    expect(h.timers.pending().map((t) => t.ms)).toEqual([30 * MINUTE]);
  });
});

describe('elicitation as a decision (F7, ADR-256)', () => {
  it('form: the card waits for the user, accept with content answers the SDK, the turn ends', async () => {
    const h = await setup({ scenario: scenario('elicitation-form'), presence: [away()] });
    setPresence(h, [away()]);
    const entryId = await h.create('Book a table for tonight');
    const decision = await openElicitation(h, entryId);
    expect(decision).toMatchObject({ serverName: 'booking', mode: 'form', unsupported: null });
    expect(decision.fields.map((f) => f.key)).toEqual(['name', 'guests', 'time', 'vegetarian']);
    expect(h.status(entryId).kind).toBe('needs-answer');
    expect(h.publisher.notifications.map((n) => n.notification.kind)).toEqual(['question']);

    expect(
      await h.cmdError({
        name: 'decision.respond',
        entryId,
        decisionId: decision.id,
        response: { kind: 'elicitation', response: { action: 'accept', content: { guests: 2 } } },
      }),
    ).toMatchObject({ code: 'DECISION_OPTION_UNAVAILABLE', params: { path: 'content.name' } });

    await h.cmd({
      name: 'decision.respond',
      entryId,
      decisionId: decision.id,
      response: { kind: 'elicitation', response: { action: 'accept', content: ELICITATION_FORM_CONTENT } },
    });
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(outcomes(h, entryId).map((op) => op.outcome)).toEqual([{ type: 'answered' }]);
    expect(h.session(entryId).diagnostics).toEqual([]);
  });

  it('url: system/elicitation_complete closes the card (answered, by nobody), the turn ends', async () => {
    const h = await setup({ scenario: scenario('elicitation-url') });
    const entryId = await h.create('Connect my calendar');
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(outcomes(h, entryId)).toMatchObject([{ outcome: { type: 'answered' }, byClientId: null }]);
    const upsert = h.publisher
      .opsOf(entryId)
      .find((op) => op.op === 'decision.upsert' && op.decision.kind === 'elicitation');
    expect(upsert?.op === 'decision.upsert' ? upsert.decision : null).toMatchObject({
      mode: 'url',
      url: 'https://auth.example/authorize?state=fake',
      elicitationId: 'elicitation-fake-url-1',
    });
    expect(h.facts(entryId).decisions.elicitation).toBe(0);
    expect(h.session(entryId).diagnostics).toEqual([]);
  });

  it('unsupported form: accept is refused with the reason, decline goes through', async () => {
    const h = await setup({ scenario: scenario('elicitation-unsupported') });
    const entryId = await h.create('Fill in the survey');
    const decision = await openElicitation(h, entryId);
    expect(decision.unsupported).toMatch(/array/);
    expect(
      await h.cmdError({
        name: 'decision.respond',
        entryId,
        decisionId: decision.id,
        response: { kind: 'elicitation', response: { action: 'accept', content: {} } },
      }),
    ).toMatchObject({ code: 'ELICITATION_UNSUPPORTED' });
    await h.cmd({
      name: 'decision.respond',
      entryId,
      decisionId: decision.id,
      response: { kind: 'elicitation', response: { action: 'decline', content: null } },
    });
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(outcomes(h, entryId).map((op) => op.outcome)).toEqual([{ type: 'declined' }]);
    expect(h.session(entryId).diagnostics).toEqual([]);
  });

  it('Stop (interrupt) cancels an open elicitation', async () => {
    const h = await setup();
    const entryId = await h.create('fake:elicit-form');
    await openElicitation(h, entryId);
    await h.cmd({ name: 'session.interrupt', entryId });
    await h.waitFor(() => h.facts(entryId).decisions.elicitation === 0);
    expect(outcomes(h, entryId).map((op) => op.outcome)).toEqual([
      { type: 'cancelled', reason: 'interrupted' },
    ]);
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
  });

  it('the process end cancels an open elicitation', async () => {
    const h = await setup();
    const entryId = await h.create('fake:elicit-url');
    await openElicitation(h, entryId);
    h.session(entryId).crash(1);
    await h.waitFor(() => h.facts(entryId).decisions.elicitation === 0);
    expect(outcomes(h, entryId).map((op) => op.outcome)).toEqual([
      { type: 'cancelled', reason: 'process_exit' },
    ]);
  });
});
