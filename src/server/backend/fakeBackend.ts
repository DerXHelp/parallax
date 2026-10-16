/**
 * FakeBackend (WP-13 §3.3): port `AgentBackend` without `claude` – deterministic, with real
 * waiting points. Plays recorded fixtures, synthetic scenarios (`backend/fake/<name>.ts`) and the
 * interactive dev scenario through ONE player with the same gates; history and session info come
 * from the `FakeHistoryStore` through the same mapping as the SdkBackend (`history/parse.ts`).
 * Default of `pnpm dev`, all engine tests and E2E.
 */
import { realSetImmediate } from '../lib/async';
import type { FixtureEvent, ParsedFixture } from './fixture';
import { mergeHistory, toHistoryMessages, toSessionInfo } from './history/parse';
import { FAKE_CONSOLE_PROMPT, consoleTurnMessages } from './fake/console';
import { randomIds } from './fake/dsl';
import { createFakeHistoryStore } from './fake/history';
import { interactiveScenario } from './fake/interactive';
import { FakeSession } from './fake/session';
import type { FakeBackend, FakeBackendOptions, FakeEventsOptions, FakeScenario } from './fake/types';

export type {
  FakeBackend,
  FakeBackendOptions,
  FakeDiagnostic,
  FakeDiagnosticKind,
  FakeEventsOptions,
  FakeIds,
  FakeScenario,
  FakeScriptContext,
  FakeScriptState,
  FakeSessionHandle,
  FakeSessionState,
} from './fake/types';
export type { FakeHistoryStore } from './fake/history';
export { createFakeHistoryStore } from './fake/history';
export { interactiveScenario } from './fake/interactive';
export { SessionStopped, TurnInterrupted } from './fake/common';
export { randomIds, sequentialIds } from './fake/dsl';
export { FAKE_CONSOLE_PROMPT, fakeConsoleAnswer } from './fake/console';

export const DEFAULT_FAKE_PID_BASE = 40_000;
export const DEFAULT_FAKE_MAX_DELAY_MS = 3_000;
/** R2-12: exited sessions and start requests kept for inspection. */
export const DEFAULT_FAKE_KEEP_SESSIONS = 50;

export function eventsScenario(
  name: string,
  events: readonly FixtureEvent[],
  options?: FakeEventsOptions,
): FakeScenario {
  return options === undefined ? { kind: 'events', name, events } : { kind: 'events', name, events, options };
}

export function fixtureScenario(parsed: ParsedFixture, options?: FakeEventsOptions): FakeScenario {
  return eventsScenario(parsed.header.scenario, parsed.events, options);
}

/** PID of the scenario's `spawn` event, else pidBase + n. */
function pidFor(scenario: FakeScenario, fallback: number): number {
  if (scenario.kind !== 'events') return fallback;
  const spawn = scenario.events.find((e) => e.kind === 'spawn');
  const payload: unknown = spawn?.payload;
  if (typeof payload === 'object' && payload !== null && 'pid' in payload && typeof payload.pid === 'number')
    return payload.pid;
  return fallback;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createFakeBackend(options: FakeBackendOptions = {}): FakeBackend {
  const now = options.now ?? (() => new Date());
  const history = options.history ?? createFakeHistoryStore({ now });
  const ids = options.ids ?? randomIds();
  const pidBase = options.pidBase ?? DEFAULT_FAKE_PID_BASE;
  const keep = Math.max(0, options.keepSessions ?? DEFAULT_FAKE_KEEP_SESSIONS);
  const starts: FakeBackend['starts'][number][] = [];
  const sessions: FakeSession[] = [];
  const listeners = new Set<() => void>();
  /** Start counter n (scenario choice, PIDs) – independent of the trimmed lists. */
  let started = 0;

  /** R2-12: drop the oldest exited sessions and start requests beyond `keep`. */
  const prune = (): void => {
    let exited = sessions.filter((s) => s.state === 'exited').length;
    for (let i = 0; i < sessions.length && exited > keep;) {
      if (sessions[i]?.state === 'exited') {
        sessions.splice(i, 1);
        exited -= 1;
      } else {
        i += 1;
      }
    }
    if (starts.length > keep) starts.splice(0, starts.length - keep);
  };

  const onStateChange = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const allSettled = (): boolean => sessions.every((s) => s.state !== 'running');

  return {
    kind: 'fake',
    starts,
    sessions,
    history,

    start(req) {
      prune();
      const n = started;
      started += 1;
      starts.push(req);
      const scenario = options.scenario?.(req, n) ?? interactiveScenario();
      const session = new FakeSession({
        n,
        req,
        scenario,
        pid: pidFor(scenario, pidBase + n),
        speed: options.speed ?? 0,
        maxDelayMs: options.maxDelayMs ?? DEFAULT_FAKE_MAX_DELAY_MS,
        sleep: options.sleep ?? defaultSleep,
        now,
        history,
        ids,
        onStateChange,
      });
      sessions.push(session);
      session.begin();
      return session;
    },

    readHistory(req) {
      const main = toHistoryMessages(history.messages(req.sessionId));
      const subagents = history.subagents(req.sessionId).map((s) => toHistoryMessages(s.messages));
      return Promise.resolve(mergeHistory(main, subagents));
    },

    getSessionInfo(req) {
      return Promise.resolve(toSessionInfo(history.info(req.sessionId)));
    },

    renameSession(req) {
      const live = sessions.find((s) => s.state !== 'exited' && s.sessionId === req.sessionId);
      // C.6: only dormant sessions may be renamed through the SDK (running: `/rename` prompt).
      live?.diagnostic('rename-running', null, `renameSession on the running session ${req.sessionId}`);
      history.rename(req.sessionId, req.title);
      return Promise.resolve();
    },

    simulateConsoleTurn(sessionId, at, text = FAKE_CONSOLE_PROMPT) {
      for (const message of consoleTurnMessages({ sessionId, at, text, ids })) {
        history.record(sessionId, message);
      }
    },

    async dispose() {
      await Promise.all(sessions.map((s) => s.close()));
    },

    settle() {
      return new Promise<void>((resolve) => {
        let done = false;
        const check = (): void => {
          if (done || !allSettled()) return;
          // Re-check one macrotask later: a gate that the engine answers at once is no resting point.
          realSetImmediate(() => {
            if (done || !allSettled()) return;
            done = true;
            listeners.delete(check);
            resolve();
          });
        };
        listeners.add(check);
        check();
      });
    },
  };
}
