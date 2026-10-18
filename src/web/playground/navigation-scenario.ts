import { LOCAL_HOST_ID, makeSessionKey, type EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import type { Conversation, HostState, SessionSummary, Settings } from '@shared/model';
import type { Command, SessionSnapshot } from '@shared/protocol';
import {
  sampleContextGauge,
  sampleConversation,
  sampleDecisions,
  sampleDetail,
  sampleHostState,
  sampleId,
  sampleItems,
  sampleProfileSummary,
  sampleRateLimitInfo,
  sampleSessionSnapshot,
  sampleStatusFacts,
  sampleSummary,
  sampleUuid,
} from '@shared/samples';
import type { StatusFacts } from '@shared/status';
import type { FakeAck, FakeHost } from '@web/state/fake-host';

/**
 * Playground data for WP-35 (sidebar flat/grouped/archive, quick switcher, header menu, banners,
 * subscription limits): two profiles, several sessions per project folder, branches, models
 * (families and a custom one), context levels 12/72/91 %, pinned, archived and external entries.
 * Times are relative to "now" so the relative times and limit resets read naturally.
 */

export const NAVIGATION_ENTRIES = {
  auth: sampleId('en', 21),
  redirect: sampleId('en', 22),
  landing: sampleId('en', 23),
  release: sampleId('en', 24),
  migration: sampleId('en', 25),
  scraper: sampleId('en', 26),
  external: sampleId('en', 27),
  prototype: sampleId('en', 28),
  spike: sampleId('en', 29),
  colors: sampleId('en', 30),
} as const;

export const NAVIGATION_SESSION_KEYS = {
  auth: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.auth),
  landing: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.landing),
  external: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.external),
  prototype: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.prototype),
} as const;

/** The second profile ("Work", blue). */
export const NAVIGATION_WORK_PROFILE = sampleId('pf', 2);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function facts(p: Partial<StatusFacts>): StatusFacts {
  return sampleStatusFacts(p);
}

function decisionCounts(p: Partial<StatusFacts['decisions']>): StatusFacts['decisions'] {
  return { permission: 0, question: 0, plan: 0, oldestKind: null, expired: 0, ...p };
}

interface Row {
  entryId: EntryId;
  title: string;
  cwd: string;
  minutesAgo: number;
  status: StatusFacts;
  extra?: Partial<SessionSummary>;
}

function rows(now: number): Row[] {
  return [
    {
      entryId: NAVIGATION_ENTRIES.auth,
      title: 'Refactoring Auth-Service',
      cwd: 'D:\\work\\auth-service',
      minutesAgo: 2,
      status: facts({ runState: 'idle', unread: true }),
      extra: {
        gitBranch: 'feature/login',
        model: 'claude-opus-5-5',
        context: sampleContextGauge({ percentage: 72, totalTokens: 720_000 }),
        profileId: NAVIGATION_WORK_PROFILE,
      },
    },
    {
      entryId: NAVIGATION_ENTRIES.redirect,
      title: 'Fix the login redirect',
      cwd: 'D:\\work\\auth-service',
      minutesAgo: 0,
      status: facts({ runState: 'working' }),
      extra: {
        gitBranch: 'fix/redirect-loop',
        model: 'claude-sonnet-5-5',
        context: sampleContextGauge({ percentage: 12, totalTokens: 120_000 }),
        profileId: NAVIGATION_WORK_PROFILE,
      },
    },
    {
      entryId: NAVIGATION_ENTRIES.landing,
      title: 'Landing page copy',
      cwd: 'D:\\work\\web\\landing',
      minutesAgo: 14,
      status: facts({ runState: 'idle' }),
      extra: {
        pinned: true,
        gitBranch: 'main',
        model: 'claude-haiku-5-5',
        context: sampleContextGauge({ percentage: 91, totalTokens: 910_000 }),
      },
    },
    {
      entryId: NAVIGATION_ENTRIES.release,
      title: 'Release notes 2.4',
      cwd: 'D:\\work\\web\\landing',
      minutesAgo: 60,
      status: facts({ runState: 'sleeping' }),
      extra: { model: null, modelSetting: 'fable', context: sampleContextGauge({ percentage: 35 }) },
    },
    {
      entryId: NAVIGATION_ENTRIES.migration,
      title: 'Database migration plan',
      cwd: 'D:\\work\\db\\migrations',
      minutesAgo: 5,
      status: facts({ runState: 'idle', decisions: decisionCounts({ plan: 1, oldestKind: 'plan' }) }),
      extra: {
        gitBranch: 'db/v7',
        model: 'internal-coder-xl',
        context: sampleContextGauge({ percentage: 55 }),
      },
    },
    {
      entryId: NAVIGATION_ENTRIES.colors,
      title: 'Answer the color question',
      cwd: 'D:\\work\\web\\landing',
      minutesAgo: 3,
      status: facts({
        runState: 'working',
        decisions: decisionCounts({ question: 1, oldestKind: 'question' }),
      }),
      extra: {
        gitBranch: 'main',
        model: 'claude-sonnet-5-5',
        context: sampleContextGauge({ percentage: 8 }),
      },
    },
    {
      entryId: NAVIGATION_ENTRIES.scraper,
      title: 'Nightly scraper',
      cwd: 'D:\\work\\scraper',
      minutesAgo: 26 * 60,
      status: facts({ runState: 'sleeping' }),
      extra: { gitBranch: 'main', model: 'claude-sonnet-5-5', context: null },
    },
    {
      entryId: NAVIGATION_ENTRIES.external,
      title: 'Continued in a terminal',
      cwd: 'D:\\work\\infra',
      minutesAgo: 25,
      status: facts({ runState: 'external' }),
      extra: {
        gitBranch: 'ops/terraform',
        external: { since: iso(now - 25 * MINUTE), pid: 52_000, running: true },
      },
    },
    {
      entryId: NAVIGATION_ENTRIES.prototype,
      title: 'Old prototype',
      cwd: 'D:\\work\\archive\\prototype',
      minutesAgo: 9 * 24 * 60,
      status: facts({ runState: 'sleeping' }),
      extra: { archived: true, gitBranch: 'spike/canvas' },
    },
    {
      entryId: NAVIGATION_ENTRIES.spike,
      title: 'Spike: WebGPU renderer',
      cwd: 'D:\\work\\spikes\\webgpu',
      minutesAgo: 20 * 24 * 60,
      status: facts({ runState: 'sleeping' }),
      extra: { archived: true },
    },
  ];
}

function conversationsOf(now: number): Conversation[] {
  return [
    sampleConversation({
      id: sampleId('cv', 212),
      sessionId: null,
      title: null,
      startedAt: iso(now - 5 * 24 * HOUR),
      endedAt: iso(now - 5 * 24 * HOUR + 10 * MINUTE),
      endReason: 'plan_mode_exit',
    }),
    sampleConversation({
      id: sampleId('cv', 211),
      sessionId: sampleUuid(211),
      title: 'Set up the OAuth client',
      startedAt: iso(now - 2 * 24 * HOUR),
      endedAt: iso(now - 24 * HOUR),
      endReason: 'clear',
    }),
    sampleConversation({
      id: sampleId('cv', 210),
      sessionId: sampleUuid(210),
      startedAt: iso(now - 3 * HOUR),
    }),
  ];
}

function snapshots(now: number): SessionSnapshot[] {
  const list: SessionSnapshot[] = [];
  for (const row of rows(now)) {
    const entryId = row.entryId;
    if (entryId === NAVIGATION_ENTRIES.auth) {
      const conversations = conversationsOf(now);
      list.push(
        sampleSessionSnapshot({
          entryId,
          detail: sampleDetail({
            entryId,
            conversationId: sampleId('cv', 210),
            conversations,
            init: {
              sessionId: sampleUuid(210),
              cwd: row.cwd,
              model: 'claude-opus-5-5',
              permissionMode: 'acceptEdits',
              apiKeySource: 'none',
              cliVersion: '2.1.300',
              tools: ['Bash', 'Read', 'Edit'],
              slashCommands: ['clear', 'rename', 'compact'],
              terminalSlashCommands: [],
              mcpServers: [
                { name: 'github', status: 'connected', source: 'user' },
                { name: 'playwright', status: 'failed', source: 'project' },
              ],
              skills: [],
              agents: [],
              plugins: [],
              capabilities: [],
              outputStyle: 'default',
              fastModeState: null,
              effort: null,
            },
          }),
        }),
      );
      continue;
    }
    const decisions =
      entryId === NAVIGATION_ENTRIES.migration
        ? [sampleDecisions.plan({ entryId, id: sampleId('dc', 250) })]
        : entryId === NAVIGATION_ENTRIES.colors
          ? [sampleDecisions.question({ entryId, id: sampleId('dc', 300) })]
          : [];
    list.push(
      sampleSessionSnapshot({
        entryId,
        seq: 0,
        items:
          entryId === NAVIGATION_ENTRIES.landing
            ? [sampleItems.userMessage({ id: 'nav:landing:prompt', order: 1 })]
            : [],
        decisions,
        detail: sampleDetail({ entryId, conversationId: sampleId('cv', 900), conversations: [] }),
      }),
    );
  }
  return list;
}

function hostState(now: number, settings: Settings): HostState {
  return sampleHostState({
    settings,
    profiles: [
      sampleProfileSummary(),
      sampleProfileSummary({
        id: NAVIGATION_WORK_PROFILE,
        name: 'Work',
        color: 'blue',
        isDefault: false,
        builtin: false,
        // A second account (WP41-05: limits are grouped by config folder).
        configDir: 'C:\\Users\\user\\.claude-work',
      }),
    ],
    accountLimits: {
      standard: sampleRateLimitInfo({
        status: 'allowed',
        windows: {
          five_hour: { utilization: 0.42, resetsAt: iso(now + 2 * HOUR + 15 * MINUTE) },
          seven_day: { utilization: 0.78, resetsAt: iso(now + 3 * 24 * HOUR) },
        },
        at: iso(now - MINUTE),
      }),
      [NAVIGATION_WORK_PROFILE]: sampleRateLimitInfo({
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.91,
        resetsAt: iso(now + 40 * MINUTE),
        windows: {},
        at: iso(now - 2 * MINUTE),
      }),
    },
  });
}

function ok(result: unknown = {}): FakeAck {
  return { ok: true, result };
}

/**
 * Phase 2 commands the FakeHost leaves to the packages (WP-30): console command, external console,
 * take back, switch conversation – enough to click through the demos.
 */
export function navigationCommands(cmd: Command, host: FakeHost): FakeAck | undefined {
  // Like the engine (WP-30 §4.12 "ohne Arbeit"): no console or switch while a turn runs.
  const busy =
    'entryId' in cmd &&
    (cmd.name === 'session.openExternal' || cmd.name === 'session.switchConversation') &&
    host.summaries.get(cmd.entryId)?.status.runState === 'working';
  if (busy) return { ok: false, error: makeError('SESSION_BUSY', { entryId: cmd.entryId }) };
  switch (cmd.name) {
    case 'session.consoleCommand': {
      const summary = host.summaries.get(cmd.entryId);
      if (summary === undefined || summary.sessionId === null) {
        return { ok: false, error: makeError('SESSION_NOT_STARTED', { entryId: cmd.entryId }) };
      }
      const command = `Set-Location -LiteralPath '${summary.cwd}'; & 'C:\\Users\\user\\.local\\bin\\claude.exe' --resume ${summary.sessionId}`;
      return ok({ command, sessionId: summary.sessionId });
    }
    case 'session.openExternal':
      host.patchSummary(
        cmd.entryId,
        { external: { since: host.now(), pid: 52_001, running: true } },
        { runState: 'external' },
      );
      return ok({ pid: 52_001 });
    case 'session.reclaim': {
      const summary = host.summaries.get(cmd.entryId);
      if (summary?.external?.running === true) {
        // Simulates the user quitting claude in the console: the next try succeeds.
        host.patchSummary(cmd.entryId, { external: { ...summary.external, running: false } });
        return { ok: false, error: makeError('EXTERNAL_STILL_RUNNING', { pid: summary.external.pid ?? 0 }) };
      }
      host.patchSummary(cmd.entryId, { external: null }, { runState: 'sleeping' });
      return ok({ importedItems: 0 });
    }
    case 'session.switchConversation': {
      const view = host.view(cmd.entryId);
      if (view === null) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
      const target = view.detail.conversations.find((c) => c.id === cmd.conversationId);
      if (target === undefined) return { ok: false, error: makeError('CONVERSATION_NOT_FOUND') };
      const previous = view.detail.conversationId;
      const conversations = [
        ...view.detail.conversations
          .filter((c) => c.id !== cmd.conversationId)
          .map((c) =>
            c.id === previous ? { ...c, endedAt: host.now(), endReason: 'switched' as const } : c,
          ),
        { ...target, endedAt: null, endReason: null },
      ];
      host.pushOps(cmd.entryId, [
        {
          op: 'conversation.reset',
          conversationId: cmd.conversationId,
          previousConversationId: previous,
          trigger: 'switch',
          hasEarlier: false,
        },
        { op: 'detail.patch', patch: { conversations } },
      ]);
      if (target.title !== null) host.patchSummary(cmd.entryId, { title: target.title });
      return ok();
    }
    default:
      return undefined;
  }
}

export interface NavigationData {
  hostState: HostState;
  summaries: SessionSummary[];
  sessions: SessionSnapshot[];
  onCommand: (cmd: Command, host: FakeHost) => FakeAck | undefined;
}

export function navigationData(now: number, settings: Settings): NavigationData {
  const summaries = rows(now).map((row) =>
    sampleSummary({
      entryId: row.entryId,
      title: row.title,
      cwd: row.cwd,
      lastActivityAt: iso(now - row.minutesAgo * MINUTE),
      createdAt: iso(now - row.minutesAgo * MINUTE - HOUR),
      status: row.status,
      sessionId: sampleUuid(Number.parseInt(row.entryId.slice(-4), 16)),
      ...row.extra,
    }),
  );
  return {
    hostState: hostState(now, settings),
    summaries,
    sessions: snapshots(now),
    onCommand: navigationCommands,
  };
}
