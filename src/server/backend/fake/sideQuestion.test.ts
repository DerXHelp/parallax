/**
 * WP-66 – the fake side question and `withdrawQueued` of the FakeBackend: levers (keywords win over
 * the option), the deterministic answer, `control_request_progress` like the CLI, cancel, a closed
 * session, the events mode. The engine path is covered by sessions/sideQuestions.integration.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SAMPLE_IDS } from '@shared/samples';
import { controlRetryOf } from '../sideQuestion';
import type { BackendEvent, SideQuestionOptions } from '../types';
import { createFakeBackend, eventsScenario, sequentialIds, type FakeBackendOptions } from '../fakeBackend';
import { createFakeClaudeIntegration } from './integration';
import { FAKE_FALLBACK_MODEL, controlProgressMessage, fakeSideAnswer, fakeSideMode } from './sideQuestion';

const launch = await createFakeClaudeIntegration().launchSpecFor('standard', SAMPLE_IDS.entry);
const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'parallax-fake-side-test-'));
afterAll(() => {
  rmSync(filesRoot, { recursive: true, force: true });
});

function harness(options: Partial<FakeBackendOptions> = {}) {
  const backend = createFakeBackend({
    ids: sequentialIds(),
    filesRoot: mkdtempSync(path.join(filesRoot, 'h-')),
    ...options,
  });
  const agent = backend.start({
    entryId: SAMPLE_IDS.entry,
    cwd: 'D:\\work\\fake',
    launch,
    resumeSessionId: null,
    model: null,
    permissionMode: null,
    effort: null,
    promptSuggestions: false,
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no' }),
  });
  const events: BackendEvent[] = [];
  const consumed = (async () => {
    for await (const event of agent.events) events.push(event);
  })();
  const progress = () =>
    events.flatMap((e) =>
      e.type === 'message' &&
      typeof e.message === 'object' &&
      e.message !== null &&
      'subtype' in e.message &&
      e.message.subtype === 'control_request_progress'
        ? [e.message]
        : [],
    );
  const close = async () => {
    await agent.close();
    await consumed;
  };
  return { backend, agent, events, progress, close };
}

function opts(o: Partial<SideQuestionOptions> = {}): SideQuestionOptions {
  return { history: [], signal: new AbortController().signal, ...o };
}

describe('fake side question helpers', () => {
  it('a keyword in the question wins over the option; default ok', () => {
    expect(fakeSideMode('plain', undefined)).toBe('ok');
    expect(fakeSideMode('plain', 'busy')).toBe('busy');
    expect(fakeSideMode('please fake:slow', 'busy')).toBe('slow');
    expect(fakeSideMode('fake:fallback', undefined)).toBe('fallback');
  });

  it('the answer names the question, the follow-up number and the turn state', () => {
    expect(fakeSideAnswer('Why?', [], false, 'ok')).toEqual({
      response: 'Fake side answer: “Why?” – Claude is idle.',
      synthetic: false,
      fallbackModel: null,
    });
    const history = [{ question: 'a', response: 'b' }];
    expect(fakeSideAnswer('And?', history, true, 'fallback')).toEqual({
      response: 'Fake side answer (follow-up 1): “And?” – Claude is working on a turn.',
      synthetic: false,
      fallbackModel: FAKE_FALLBACK_MODEL,
    });
    expect(fakeSideAnswer('x', [], false, 'synthetic').synthetic).toBe(true);
    expect(fakeSideAnswer('y'.repeat(200), [], false, 'ok').response).toContain(`${'y'.repeat(120)}…`);
  });

  it('control_request_progress has the CLI shape (the retry parser reads it)', () => {
    const ids = { uuid: 'u1', sessionId: 's1' };
    expect(controlRetryOf(controlProgressMessage({ requestId: 'r', status: 'started' }, ids))).toBeNull();
    expect(
      controlRetryOf(controlProgressMessage({ requestId: 'r', status: 'api_retry', attempt: 2, maxRetries: 10 }, ids)),
    ).toEqual({ attempt: 2, maxRetries: 10 });
  });
});

describe('FakeBackend – askSideQuestion and withdrawQueued (WP-66)', () => {
  it('answers after one started progress; retry reports api_retry first', async () => {
    const h = harness();
    await expect(h.agent.askSideQuestion('Why?', opts())).resolves.toEqual({
      ok: true,
      answer: { response: 'Fake side answer: “Why?” – Claude is idle.', synthetic: false, fallbackModel: null },
    });
    await h.backend.settle();
    expect(h.progress()).toHaveLength(1);
    expect(h.progress()[0]).toMatchObject({ status: 'started' });
    const retries: unknown[] = [];
    await h.agent.askSideQuestion('fake:retry', opts({ onRetry: (r) => retries.push(r) }));
    await h.backend.settle();
    expect(retries).toEqual([{ attempt: 1, maxRetries: 10 }]);
    expect(h.progress().map((m) => controlRetryOf(m))).toEqual([null, null, { attempt: 1, maxRetries: 10 }]);
    await h.close();
  });

  it('levers: none → null answer, busy, failed, unavailable (option and keyword)', async () => {
    const h = harness({ sideQuestions: { mode: 'busy' } });
    await expect(h.agent.askSideQuestion('x', opts())).resolves.toEqual({ ok: false, reason: 'busy' });
    await expect(h.agent.askSideQuestion('fake:none', opts())).resolves.toEqual({ ok: true, answer: null });
    await expect(h.agent.askSideQuestion('fake:fail', opts())).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(h.agent.askSideQuestion('fake:unavailable', opts())).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
    await h.close();
  });

  it('slow: only a cancel ends it at speed 0; a closed session answers failed', async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = h.agent.askSideQuestion('fake:slow', opts({ signal: controller.signal }));
    await h.backend.settle();
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' });
    const open = h.agent.askSideQuestion('fake:slow', opts());
    await h.backend.settle();
    await h.close();
    await expect(open).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(h.agent.askSideQuestion('x', opts())).resolves.toEqual({ ok: false, reason: 'failed' });
  });

  it('events mode: unavailable (no recorded answer)', async () => {
    const h = harness({ scenario: () => eventsScenario('empty', []) });
    await expect(h.agent.askSideQuestion('x', opts())).resolves.toEqual({ ok: false, reason: 'unavailable' });
    await h.close();
  });

  it('withdrawQueued: unknown uuid → false; unavailable rejects; a closed session rejects', async () => {
    const h = harness();
    await expect(h.agent.withdrawQueued('00000000-0000-4000-8000-000000000001')).resolves.toBe(false);
    await h.close();
    await expect(h.agent.withdrawQueued('00000000-0000-4000-8000-000000000001')).rejects.toThrow();
    const u = harness({ sideQuestions: { withdraw: 'unavailable' } });
    await expect(u.agent.withdrawQueued('00000000-0000-4000-8000-000000000001')).rejects.toThrow(/missing/);
    await u.close();
  });
});
