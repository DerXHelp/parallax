/**
 * Synthetic engine scenarios (`backend/fake/<name>.ts`): fixture format v1, the real normalizer
 * (schema-true ops), and playback through the FakeBackend with the expected gates and exits.
 * The WP-12 streams play through the FakeBackend unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { SAMPLE_IDS } from '@shared/samples';
import { sessionOpSchema } from '@shared/protocol';
import {
  FIXTURE_VERSION,
  fixtureEventSchema,
  fixtureInputPayloadSchema,
  parseFixture,
  type FixtureEvent,
} from '../fixture';
import { finalItems, replayLive, signalList } from '../../sessions/normalizer/testing/harness';
import { SYNTHETIC_STREAMS } from '../../sessions/normalizer/synthetic';
import type { BackendEvent, PermissionHandler, StartSessionRequest } from '../types';
import { createFakeBackend, eventsScenario, sequentialIds, type FakeBackend } from '../fakeBackend';
import { mapUuids } from './common';
import { createFakeClaudeIntegration } from './integration';
import { FAKE_SCENARIOS } from './synthetic';
import { driveFixtureSession, recordedPrompts } from './testing';

const launch = await createFakeClaudeIntegration().launchSpecFor('standard', SAMPLE_IDS.entry);

function request(canUseTool: PermissionHandler): StartSessionRequest {
  return {
    entryId: SAMPLE_IDS.entry,
    cwd: 'D:\\work\\fake',
    launch,
    resumeSessionId: null,
    model: null,
    permissionMode: null,
    effort: null,
    promptSuggestions: false,
    canUseTool,
  };
}

const allow: PermissionHandler = (req) =>
  Promise.resolve({ behavior: 'allow', updatedInput: req.input, decisionClassification: 'user_temporary' });

function scenario(name: string): readonly FixtureEvent[] {
  const ev = FAKE_SCENARIOS[name];
  if (ev === undefined) throw new Error(`scenario ${name} missing`);
  return ev;
}

async function play(ev: readonly FixtureEvent[], handler: PermissionHandler = allow) {
  const backend: FakeBackend = createFakeBackend({ scenario: () => eventsScenario('s', ev) });
  const agent = backend.start(request(handler));
  const handle = backend.sessions[0];
  if (handle === undefined) throw new Error('no handle');
  const result = await driveFixtureSession(backend, agent, handle, recordedPrompts(ev, uuidGenerator()));
  return { backend, handle, ...result };
}

const exitOf = (events: readonly BackendEvent[]) => events.at(-1);

function uuidGenerator(): () => string {
  const ids = sequentialIds();
  return () => ids.uuid();
}

describe.each(Object.keys(FAKE_SCENARIOS).sort())('fake scenario %s', (name) => {
  it('is valid fixture format v1 and normalizes schema-true', () => {
    const ev = scenario(name);
    for (const event of ev) expect(fixtureEventSchema.safeParse(event).success).toBe(true);
    const header = {
      fixtureVersion: FIXTURE_VERSION,
      scenario: name,
      sdkVersion: '0.3.296',
      cliVersion: '2.1.300',
      recordedAt: '2026-10-15T08:00:00.000Z',
      options: { synthetic: true },
    };
    expect(parseFixture([header, ...ev].map((l) => JSON.stringify(l)).join('\n'), name).events).toHaveLength(
      ev.length,
    );
    const r = replayLive({ events: [...ev] });
    for (const op of r.steps.flatMap((s) => s.ops)) expect(sessionOpSchema.parse(op)).toStrictEqual(op);
  });
});

describe('fake scenarios â€“ behaviour', () => {
  it('crash-mid-turn: partial stream, exit code 1 unexpected', async () => {
    const { events, handle } = await play(scenario('crash-mid-turn'));
    expect(exitOf(events)).toMatchObject({ type: 'exit', code: 1, expected: false });
    expect(handle.diagnostics).toEqual([]);
    const items = Object.values(finalItems(replayLive({ events: [...scenario('crash-mid-turn')] }))).flat();
    expect(items.some((i) => i.kind === 'turn_result')).toBe(false);
  });

  it('crash-awaiting-decision: the request is open when the process dies; its signal aborts afterwards', async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const { events } = await play(scenario('crash-awaiting-decision'), (_req, s) => {
      seen.signal = s;
      return new Promise<PermissionResult>(() => undefined);
    });
    expect(exitOf(events)).toMatchObject({ type: 'exit', code: 1, expected: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen.signal?.aborted).toBe(true);
  });

  it('idle-crash: a successful turn, then exit code 3', async () => {
    const { events, handle } = await play(scenario('idle-crash'));
    expect(
      events
        .filter((e) => e.type === 'message')
        .some((e) => JSON.stringify(e).includes('"subtype":"success"')),
    ).toBe(true);
    expect(exitOf(events)).toMatchObject({ code: 3, expected: false });
    expect(handle.diagnostics).toEqual([]);
  });

  it('startup-held-elsewhere: startup failure SESSION_HELD_ELSEWHERE, then exit 1', async () => {
    const r = replayLive({ events: [...scenario('startup-held-elsewhere')] });
    expect(signalList(r).find((s) => s.type === 'turn_result')).toMatchObject({
      startupFailure: true,
      error: { code: 'SESSION_HELD_ELSEWHERE' },
    });
    const { events } = await play(scenario('startup-held-elsewhere'));
    expect(exitOf(events)).toMatchObject({ code: 1, expected: false });
  });

  it('setup-auth-error: CLAUDE_AUTH_FAILED, the process waits for close()', async () => {
    const r = replayLive({ events: [...scenario('setup-auth-error')] });
    expect(signalList(r).find((s) => s.type === 'assistant_error')).toMatchObject({
      error: { code: 'CLAUDE_AUTH_FAILED' },
    });
    const { events } = await play(scenario('setup-auth-error'));
    expect(exitOf(events)).toMatchObject({ code: 0, expected: true });
  });

  it('parallel-decisions: two open requests with agentId at the same time, answers in any order', async () => {
    const ev = scenario('parallel-decisions');
    const pending = new Map<string, { agentId: string | null; resolve: (r: PermissionResult) => void }>();
    const backend = createFakeBackend({ scenario: () => eventsScenario('p', ev) });
    const agent = backend.start(
      request(
        (req) =>
          new Promise((resolve) => {
            pending.set(req.toolUseId, { agentId: req.agentId, resolve });
          }),
      ),
    );
    const handle = backend.sessions[0];
    if (handle === undefined) throw new Error('no handle');
    const consumed = (async () => {
      for await (const _event of agent.events) {
        // drain
      }
    })();
    const [first] = recordedPrompts(ev, uuidGenerator());
    if (first === undefined) throw new Error('no prompt');
    agent.send(first);
    await backend.settle();
    expect([...pending.entries()].map(([id, p]) => [id, p.agentId])).toEqual([
      ['toolu_fake_bash_a', 'task-a'],
      ['toolu_fake_bash_b', 'task-b'],
    ]);
    expect(handle.state).toBe('waiting-decision');
    pending
      .get('toolu_fake_bash_b')
      ?.resolve({
        behavior: 'allow',
        updatedInput: { command: 'echo step-b', description: 'Step b' },
        decisionClassification: 'user_temporary',
      });
    pending
      .get('toolu_fake_bash_a')
      ?.resolve({
        behavior: 'allow',
        updatedInput: { command: 'echo step-a', description: 'Step a' },
        decisionClassification: 'user_temporary',
      });
    await backend.settle();
    expect(handle.state).toBe('waiting-close');
    expect(handle.diagnostics).toEqual([]);
    await agent.close();
    await consumed;
  });

  it('abort-decision: the CLI aborts the open request, the turn ends normally', async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const { events, handle } = await play(scenario('abort-decision'), (_req, s) => {
      seen.signal = s;
      return new Promise<PermissionResult>(() => undefined);
    });
    expect(seen.signal?.aborted).toBe(true);
    expect(exitOf(events)).toMatchObject({ code: 0, expected: true });
    expect(handle.diagnostics).toEqual([]);
  });

  it('queued-then-crash: second prompt queued, never started, then exit 1', async () => {
    const ev = scenario('queued-then-crash');
    const { events, sent, handle } = await play(ev);
    expect(sent).toHaveLength(2);
    const lifecycles = events.flatMap((e) =>
      e.type === 'message' && JSON.stringify(e.message).includes('command_lifecycle') ? [e.message] : [],
    );
    expect(lifecycles).toContainEqual(
      expect.objectContaining({ command_uuid: sent[1]?.uuid, state: 'queued' }),
    );
    expect(
      lifecycles.some((m) => JSON.stringify(m).includes(`"${sent[1]?.uuid ?? ''}","state":"started"`)),
    ).toBe(false);
    expect(exitOf(events)).toMatchObject({ code: 1, expected: false });
    expect(handle.diagnostics).toEqual([]);
  });
});

describe('WP-12 synthetic streams play through the FakeBackend unchanged', () => {
  it.each(Object.keys(SYNTHETIC_STREAMS).sort())('%s', async (name) => {
    const ev = SYNTHETIC_STREAMS[name] ?? [];
    const { events, sent, handle } = await play(ev);
    const recordedInputs = ev
      .filter((e) => e.kind === 'input')
      .map((e) => fixtureInputPayloadSchema.parse(e.payload).uuid);
    const map = new Map(recordedInputs.map((uuid, i) => [uuid, sent[i]?.uuid ?? uuid]));
    const expected = ev.filter((e) => e.kind === 'message').map((e) => mapUuids(e.payload, map));
    expect(events.flatMap((e) => (e.type === 'message' ? [e.message] : []))).toEqual(expected);
    expect(handle.diagnostics).toEqual([]);
  });
});
