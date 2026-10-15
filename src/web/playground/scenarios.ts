import { LOCAL_HOST_ID, makeSessionKey, type EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import type { Decision, HostState, SessionSummary, Settings, TranscriptItem } from '@shared/model';
import type { SessionSnapshot } from '@shared/protocol';
import {
  sampleClaudeInstallStatus,
  sampleDecisions,
  sampleDetail,
  sampleHostState,
  sampleId,
  sampleItems,
  sampleProfileSummary,
  sampleSessionSnapshot,
  sampleStatusFacts,
  sampleSummary,
  sampleSystemItems,
} from '@shared/samples';
import type { StatusFacts } from '@shared/status';
import type { AuthCheckResult } from '@web/state/auth';
import type { FakeHost } from '@web/state/fake-host';

/**
 * Playground scenarios: sample data from @shared/samples (fixed ids; times relative to "now" only
 * where the status depends on them, e.g. rate limits) served by the FakeHost over the in-memory
 * transport. Feature demos (WP-15/16) can reuse them via `<PlaygroundScenario>` and
 * `PLAYGROUND_SESSION_KEYS`.
 */

export const PLAYGROUND_ENTRIES = {
  /** Finished turn: user message, thinking, text, Bash tool call, turn result. */
  main: sampleId('en', 1),
  /** Working session that streams assistant text (deltas). */
  streaming: sampleId('en', 2),
  /** Three open decisions: permission, question, plan. */
  decisions: sampleId('en', 3),
} as const;

export const PLAYGROUND_SESSION_KEYS = {
  main: makeSessionKey(LOCAL_HOST_ID, PLAYGROUND_ENTRIES.main),
  streaming: makeSessionKey(LOCAL_HOST_ID, PLAYGROUND_ENTRIES.streaming),
  decisions: makeSessionKey(LOCAL_HOST_ID, PLAYGROUND_ENTRIES.decisions),
} as const;

export const SCENARIO_IDS = [
  'overview',
  'streaming',
  'decisions',
  'empty',
  'setup',
  'offline',
  'signed-out',
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface ScenarioData {
  hostState: HostState;
  summaries: SessionSummary[];
  sessions: SessionSnapshot[];
}

export interface Scenario {
  id: ScenarioId;
  /** Developer text. */
  title: string;
  /** Session selected when the scenario starts. */
  select: string | null;
  /** Result of the auth check before the WS (default: signed in, no check). */
  auth?: AuthCheckResult;
  build(now: number, settings: Settings): ScenarioData;
  /** Live behaviour after the start (timers); returns the stop function. */
  start?(host: FakeHost, now: () => number): () => void;
}

const MINUTE = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function facts(p: Partial<StatusFacts>): StatusFacts {
  return sampleStatusFacts(p);
}

function decisionCounts(p: Partial<StatusFacts['decisions']>): StatusFacts['decisions'] {
  return { permission: 0, question: 0, plan: 0, oldestKind: null, expired: 0, ...p };
}

function emptySnapshot(
  entryId: EntryId,
  items: TranscriptItem[] = [],
  decisions: Decision[] = [],
): SessionSnapshot {
  return sampleSessionSnapshot({
    entryId,
    seq: 0,
    items,
    decisions,
    detail: sampleDetail({ entryId }),
  });
}

interface OverviewRow {
  n: number;
  title: string;
  cwd: string;
  minutesAgo: number;
  status: StatusFacts;
  extra?: Partial<SessionSummary>;
}

function overviewRows(now: number): OverviewRow[] {
  return [
    {
      n: 1,
      title: 'Sample session',
      cwd: 'D:\\work\\sample',
      minutesAgo: 1,
      status: facts({ runState: 'idle', unread: true }),
    },
    {
      n: 2,
      title: 'Stream a long answer',
      cwd: 'D:\\work\\parallax\\docs',
      minutesAgo: 0,
      status: facts({ runState: 'working' }),
    },
    {
      n: 3,
      title: 'Three open decisions',
      cwd: 'D:\\work\\parallax\\src\\server',
      minutesAgo: 2,
      status: facts({
        runState: 'working',
        decisions: decisionCounts({ permission: 1, question: 1, plan: 1, oldestKind: 'permission' }),
      }),
    },
    {
      n: 4,
      title: 'Answer the color question',
      cwd: 'D:\\work\\web\\landing',
      minutesAgo: 4,
      status: facts({
        runState: 'working',
        decisions: decisionCounts({ question: 1, oldestKind: 'question' }),
      }),
    },
    {
      n: 5,
      title: 'Review the migration plan',
      cwd: 'D:\\work\\db\\migrations',
      minutesAgo: 6,
      status: facts({ runState: 'idle', decisions: decisionCounts({ plan: 1, oldestKind: 'plan' }) }),
    },
    {
      n: 6,
      title: 'Plan approval after restart',
      cwd: 'D:\\work\\billing',
      minutesAgo: 90,
      status: facts({ runState: 'interrupted', decisions: decisionCounts({ expired: 1 }) }),
    },
    {
      n: 7,
      title: 'Crashed while running tests',
      cwd: 'D:\\work\\api\\tests',
      minutesAgo: 12,
      status: facts({ runState: 'error', errorCode: 'CLAUDE_PROCESS_CRASHED' }),
      extra: { lastError: { code: 'CLAUDE_PROCESS_CRASHED', params: {}, at: iso(now - 12 * MINUTE) } },
    },
    {
      n: 8,
      title: 'Interrupted refactoring',
      cwd: 'D:\\work\\auth-service',
      minutesAgo: 30,
      status: facts({ runState: 'interrupted' }),
    },
    {
      n: 9,
      title: 'Waiting for the rate limit',
      cwd: 'D:\\work\\scraper',
      minutesAgo: 8,
      status: facts({ runState: 'idle', rateLimitedUntil: iso(now + 45 * MINUTE) }),
    },
    {
      n: 10,
      title: 'Starting up',
      cwd: 'D:\\work\\new-project',
      minutesAgo: 0,
      status: facts({ runState: 'starting' }),
    },
    {
      n: 11,
      title: 'Background build is running',
      cwd: 'D:\\work\\desktop-app',
      minutesAgo: 3,
      status: facts({ runState: 'idle', backgroundTasks: 2 }),
    },
    {
      n: 12,
      title: 'Idle helper session',
      cwd: 'D:\\work\\scripts',
      minutesAgo: 120,
      status: facts({ runState: 'idle' }),
    },
    {
      n: 13,
      title: 'Sleeping since yesterday',
      cwd: 'D:\\work\\archive\\old',
      minutesAgo: 26 * 60,
      status: facts({ runState: 'sleeping' }),
    },
    {
      n: 14,
      title: 'Continued in a terminal',
      cwd: 'D:\\work\\infra',
      minutesAgo: 45,
      status: facts({ runState: 'external' }),
    },
  ];
}

function overviewData(now: number, settings: Settings): ScenarioData {
  const summaries = overviewRows(now).map((row) =>
    sampleSummary({
      entryId: sampleId('en', row.n),
      title: row.title,
      cwd: row.cwd,
      lastActivityAt: iso(now - row.minutesAgo * MINUTE),
      status: row.status,
      ...row.extra,
    }),
  );
  const decisionsFor = (entryId: EntryId) => ({ entryId });
  const sessions: SessionSnapshot[] = [
    sampleSessionSnapshot(),
    emptySnapshot(PLAYGROUND_ENTRIES.streaming, [
      sampleItems.userMessage({
        id: 'px:stream:prompt',
        order: 1,
        text: { text: 'Explain the sync protocol.', truncated: null },
      }),
    ]),
    emptySnapshot(
      PLAYGROUND_ENTRIES.decisions,
      [
        sampleItems.userMessage({
          id: 'px:decisions:prompt',
          order: 1,
          text: { text: 'Set up the build folder.', truncated: null },
        }),
        sampleItems.toolCall({
          id: 'px:decisions:tool',
          order: 2,
          status: 'awaiting_decision',
          result: null,
        }),
      ],
      [
        sampleDecisions.permission(decisionsFor(PLAYGROUND_ENTRIES.decisions)),
        sampleDecisions.question(decisionsFor(PLAYGROUND_ENTRIES.decisions)),
        sampleDecisions.plan(decisionsFor(PLAYGROUND_ENTRIES.decisions)),
      ],
    ),
    emptySnapshot(
      sampleId('en', 4),
      [],
      [sampleDecisions.question({ ...decisionsFor(sampleId('en', 4)), id: sampleId('dc', 40) })],
    ),
    emptySnapshot(
      sampleId('en', 5),
      [],
      [sampleDecisions.plan({ ...decisionsFor(sampleId('en', 5)), id: sampleId('dc', 50) })],
    ),
    emptySnapshot(
      sampleId('en', 6),
      [sampleSystemItems.interrupted({ order: 1 })],
      [
        sampleDecisions.plan({
          ...decisionsFor(sampleId('en', 6)),
          id: sampleId('dc', 60),
          state: 'expired',
        }),
      ],
    ),
    emptySnapshot(sampleId('en', 7), [
      sampleSystemItems.error({ order: 1, error: makeError('CLAUDE_PROCESS_CRASHED') }),
    ]),
  ];
  for (let n = 8; n <= 14; n++) sessions.push(emptySnapshot(sampleId('en', n)));
  return { hostState: sampleHostState({ settings }), summaries, sessions };
}

/** One streamed reply per round: Markdown with a list and a code block (exercises WP-15). */
const STREAM_TEXT = [
  'The sync protocol has **two channels**:',
  '',
  '1. Host-wide summaries (status, title, context) for every window.',
  '2. Per-session subscriptions with a `seq` per op and a ring buffer for replays.',
  '',
  'A reconnect sends `subscribe { entryId, sinceSeq }`; the server answers with a replay or a snapshot:',
  '',
  '```ts',
  'const { state, gap } = applySeqOps(view, ops);',
  'if (gap) resubscribe(view.seq);',
  '```',
  '',
  'Deltas are coalesced on the server every 40 ms and applied once per animation frame.',
].join('\n');

function startStreaming(host: FakeHost, now: () => number): () => void {
  const entryId = PLAYGROUND_ENTRIES.streaming;
  let round = 0;
  let cancel: (() => void) | null = null;
  let stopped = false;
  const next = () => {
    if (stopped || round >= 20) return;
    round++;
    const order = (host.view(entryId)?.items.at(-1)?.order ?? 0) + 1;
    if (round > 1) {
      host.pushOps(entryId, [
        {
          op: 'item.upsert',
          item: sampleItems.userMessage({
            id: `px:stream:prompt:${String(round)}`,
            order,
            at: new Date(now()).toISOString(),
            text: { text: 'And once more, please.', truncated: null },
          }),
        },
      ]);
    }
    host.patchSummary(entryId, { lastActivityAt: new Date(now()).toISOString() }, { runState: 'working' });
    const messageId = `msg_stream_${String(round)}`;
    cancel = host.streamAssistantText(entryId, {
      item: sampleItems.assistantText({
        id: `${messageId}:0`,
        messageId,
        blockIndex: 0,
        order: order + 1,
        at: new Date(now()).toISOString(),
        streaming: true,
        text: '',
      }),
      text: STREAM_TEXT,
      chunkSize: 5,
      intervalMs: 35,
      onDone: () => {
        host.patchSummary(
          entryId,
          { lastActivityAt: new Date(now()).toISOString() },
          { runState: 'idle', unread: true },
        );
        host.later(next, 4000);
      },
    });
  };
  host.later(next, 600);
  return () => {
    stopped = true;
    cancel?.();
  };
}

export const SCENARIOS: Readonly<Record<ScenarioId, Scenario>> = {
  overview: {
    id: 'overview',
    title: 'All 14 display statuses',
    select: PLAYGROUND_SESSION_KEYS.main,
    build: overviewData,
  },
  streaming: {
    id: 'streaming',
    title: 'Streaming assistant text (item.delta)',
    select: PLAYGROUND_SESSION_KEYS.streaming,
    build: overviewData,
    start: startStreaming,
  },
  decisions: {
    id: 'decisions',
    title: 'Open permission, question and plan decisions',
    select: PLAYGROUND_SESSION_KEYS.decisions,
    build: overviewData,
  },
  empty: {
    id: 'empty',
    title: 'No sessions yet',
    select: null,
    build: (_now, settings) => ({ hostState: sampleHostState({ settings }), summaries: [], sessions: [] }),
  },
  setup: {
    id: 'setup',
    title: 'Setup required (claude not found)',
    select: null,
    build: (now, settings) => ({
      ...overviewData(now, settings),
      hostState: sampleHostState({
        settings,
        setupRequired: true,
        profiles: [
          sampleProfileSummary({
            claude: sampleClaudeInstallStatus({
              state: 'not_found',
              path: null,
              version: null,
              versionStatus: 'unknown',
              error: makeError('CLAUDE_NOT_FOUND'),
            }),
          }),
        ],
        warnings: [{ id: 'w1', error: makeError('STORE_CORRUPT_QUARANTINED'), at: iso(now) }],
      }),
    }),
  },
  offline: {
    id: 'offline',
    title: 'Server not reachable (retry with backoff)',
    select: null,
    auth: { kind: 'unreachable' },
    build: overviewData,
  },
  'signed-out': {
    id: 'signed-out',
    title: 'Not signed in (rejected #code=)',
    select: null,
    auth: { kind: 'unauthenticated', codeRejected: true },
    build: overviewData,
  },
};
