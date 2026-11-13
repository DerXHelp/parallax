import { LOCAL_HOST_ID, makeSessionKey, type EntryId } from '@shared/common';
import type {
  ContextGauge,
  Decision,
  HostState,
  PlanVersionInfo,
  SessionDetail,
  SessionFile,
  SessionFileOp,
  SessionSummary,
  Settings,
  ToolCallItem,
  TranscriptItem,
} from '@shared/model';
import type { SessionSnapshot } from '@shared/protocol';
import {
  sampleClaudeInstallStatus,
  sampleConversation,
  sampleDetail,
  sampleHostState,
  sampleId,
  sampleModelOption,
  sampleProfileSummary,
  sampleRateLimitInfo,
  sampleSessionSnapshot,
  sampleStatusFacts,
  sampleSummary,
} from '@shared/samples';
import type { StatusFacts } from '@shared/status';
import type { FakeHost } from '@web/state/fake-host';
import { SHOWCASE_FILE_PATHS, SHOWCASE_ROOTS } from './files';
import { PLAN_FILE, PLAN_V1, PLAN_V2 } from './plans';
import { HAIKU, OPUS, SHOWCASE_DECISION_IDS, SHOWCASE_TRANSCRIPTS, SONNET } from './transcripts';

/**
 * The README showcase (WP-68): one developer's Thursday afternoon with four invented projects and
 * eight sessions in every interesting state – working, waiting for a permission and a plan, done and
 * new, Remote Control, a background agent, sleeping, archived. Times are relative to `now` (the
 * screenshot script fixes the clock at SHOWCASE_NOW). German content, English code and CLI texts.
 */

export { SHOWCASE_NOW } from './clock';

const CLI_VERSION = '2.1.323';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const SHOWCASE_ENTRIES = {
  paypal: sampleId('en', 0x681),
  lighthouse: sampleId('en', 0x682),
  filter: sampleId('en', 0x683),
  rateLimit: sampleId('en', 0x684),
  flaky: sampleId('en', 0x685),
  deps: sampleId('en', 0x686),
  push: sampleId('en', 0x687),
  postgres: sampleId('en', 0x688),
} as const;
type ShowcaseKey = keyof typeof SHOWCASE_ENTRIES;

export const SHOWCASE_SESSION_KEYS = {
  paypal: makeSessionKey(LOCAL_HOST_ID, SHOWCASE_ENTRIES.paypal),
  rateLimit: makeSessionKey(LOCAL_HOST_ID, SHOWCASE_ENTRIES.rateLimit),
  push: makeSessionKey(LOCAL_HOST_ID, SHOWCASE_ENTRIES.push),
} as const;

const ARCHIVED = [sampleId('en', 0x691), sampleId('en', 0x692), sampleId('en', 0x693)] as const;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function decisionCounts(p: Partial<StatusFacts['decisions']>): StatusFacts['decisions'] {
  return { permission: 0, question: 0, plan: 0, oldestKind: null, expired: 0, ...p };
}

function gauge(model: string, totalTokens: number, maxTokens: number, at: string): ContextGauge {
  return {
    percentage: Math.round((totalTokens / maxTokens) * 100),
    totalTokens,
    maxTokens,
    source: 'sdk',
    model,
    at,
    autoCompactThreshold: null,
    isAutoCompactEnabled: true,
  };
}

interface Row {
  key: ShowcaseKey;
  title: string;
  cwd: string;
  /** Last activity, minutes before now. */
  minutesAgo: number;
  /** Start of the session, hours before now. */
  startedHoursAgo: number;
  model: string;
  modelSetting: string;
  tokens: number;
  maxTokens: number;
  status: Partial<StatusFacts>;
  extra?: Partial<SessionSummary>;
}

function rows(now: number): Row[] {
  const ago = (minutes: number) => iso(now - minutes * MINUTE);
  return [
    {
      key: 'paypal',
      title: 'PayPal Express im Checkout',
      cwd: SHOWCASE_ROOTS.shop,
      minutesAgo: 0,
      startedHoursAgo: 1.2,
      model: OPUS,
      modelSetting: 'opus',
      tokens: 92_400,
      maxTokens: 200_000,
      status: { runState: 'working' },
      extra: {
        gitBranch: 'feature/paypal-express',
        permissionMode: 'acceptEdits',
        activity: { kind: 'tool', tool: 'Bash', target: 'Tests ausführen' },
      },
    },
    {
      key: 'lighthouse',
      title: 'Lighthouse: Bilder der Startseite',
      cwd: SHOWCASE_ROOTS.shop,
      minutesAgo: 2,
      startedHoursAgo: 0.4,
      model: SONNET,
      modelSetting: 'sonnet',
      tokens: 61_800,
      maxTokens: 200_000,
      status: {
        runState: 'working',
        decisions: decisionCounts({ permission: 1, oldestKind: 'permission' }),
      },
      extra: {
        gitBranch: 'perf/hero-images',
        permissionMode: 'default',
        activity: { kind: 'tool', tool: 'Bash', target: 'Produktionsbuild erstellen' },
      },
    },
    {
      key: 'filter',
      title: 'Produktfilter mit Mehrfachauswahl',
      cwd: SHOWCASE_ROOTS.shop,
      minutesAgo: 31,
      startedHoursAgo: 2.5,
      model: SONNET,
      modelSetting: 'sonnet',
      tokens: 48_300,
      maxTokens: 200_000,
      status: { runState: 'idle', unread: true },
      extra: {
        gitBranch: 'feature/multi-filter',
        permissionMode: 'acceptEdits',
        lastSeenAt: ago(70),
        turnSummary: {
          source: 'parallax',
          text: 'Farbe und Größe sind jetzt Mehrfachauswahl. Die Auswahl steht als ?farbe=blau,grau&groesse=m,l in der URL, Zurück im Browser stellt den Filter wieder her. Alle 14 Filter-Tests sind grün.',
          category: null,
          needsAction: false,
          at: ago(31),
        },
      },
    },
    {
      key: 'rateLimit',
      title: 'Rate-Limiting für /v2/connections',
      cwd: SHOWCASE_ROOTS.api,
      minutesAgo: 4,
      startedHoursAgo: 0.6,
      model: OPUS,
      modelSetting: 'opus',
      tokens: 38_900,
      maxTokens: 200_000,
      status: { runState: 'working', decisions: decisionCounts({ plan: 1, oldestKind: 'plan' }) },
      extra: {
        gitBranch: 'feature/rate-limit',
        effort: 'high',
        permissionMode: 'plan',
        turnSummary: {
          source: 'parallax',
          text: 'Plan v2 steht.',
          category: null,
          needsAction: false,
          at: ago(4),
        },
      },
    },
    {
      key: 'flaky',
      title: 'Flaky Test test_departures_timezone',
      cwd: SHOWCASE_ROOTS.api,
      minutesAgo: 81,
      startedHoursAgo: 3,
      model: SONNET,
      modelSetting: 'sonnet',
      tokens: 27_500,
      maxTokens: 200_000,
      status: { runState: 'idle' },
      extra: {
        gitBranch: 'fix/flaky-timezone',
        turnSummary: {
          source: 'parallax',
          text: 'Ursache: Die Fixture frozen_departure baut ein naives datetime.now(). Läuft die CI kurz vor Mitternacht UTC, liegt die Abfahrt in Berlin schon am nächsten Tag. Die Fixture nutzt jetzt Europe/Berlin – 50 von 50 Läufen grün.',
          category: null,
          needsAction: false,
          at: ago(81),
        },
      },
    },
    {
      key: 'deps',
      title: 'Abhängigkeiten aktualisieren',
      cwd: SHOWCASE_ROOTS.api,
      minutesAgo: 26 * 60,
      startedHoursAgo: 27,
      model: HAIKU,
      modelSetting: 'haiku',
      tokens: 18_200,
      maxTokens: 200_000,
      status: { runState: 'sleeping' },
      extra: {
        gitBranch: 'chore/deps',
        turnSummary: {
          source: 'parallax',
          text: '12 Pakete aktualisiert, darunter FastAPI 0.121 und Pydantic 2.12 – keine Breaking Changes für uns. Alle 214 Tests sind grün.',
          category: null,
          needsAction: false,
          at: ago(26 * 60),
        },
      },
    },
    {
      key: 'push',
      title: 'Erinnerungen für Termine',
      cwd: SHOWCASE_ROOTS.app,
      minutesAgo: 0,
      startedHoursAgo: 0.5,
      model: SONNET,
      modelSetting: 'sonnet',
      tokens: 74_600,
      maxTokens: 200_000,
      status: { runState: 'working', backgroundTasks: 1 },
      extra: {
        gitBranch: 'feature/event-reminders',
        effort: 'medium',
        permissionMode: 'acceptEdits',
        activity: { kind: 'thinking' },
      },
    },
    {
      key: 'postgres',
      title: 'Staging: Postgres 16',
      cwd: SHOWCASE_ROOTS.infra,
      minutesAgo: 1,
      startedHoursAgo: 0.1,
      model: OPUS,
      modelSetting: 'opus',
      tokens: 22_100,
      maxTokens: 200_000,
      status: { runState: 'working' },
      extra: {
        gitBranch: 'ops/postgres-16',
        permissionMode: 'default',
        activity: { kind: 'claude', text: 'Running terraform plan for the staging RDS module' },
        remoteControl: {
          state: 'connected',
          sessionUrl: 'https://claude.ai/code/session_01KfRw3zXq8LmT2vNcYp7d9a',
          error: null,
          wanted: true,
        },
      },
    },
  ];
}

const ARCHIVED_ROWS = [
  { title: 'Newsletter-Anmeldung mit Double-Opt-in', cwd: SHOWCASE_ROOTS.shop, days: 6 },
  { title: 'GTFS-Import beschleunigen', cwd: SHOWCASE_ROOTS.api, days: 9 },
  { title: 'Spielplan als PDF exportieren', cwd: SHOWCASE_ROOTS.app, days: 14 },
] as const;

function summaries(now: number): SessionSummary[] {
  const live = rows(now).map((row) => {
    const entryId = SHOWCASE_ENTRIES[row.key];
    const lastActivityAt = iso(now - row.minutesAgo * MINUTE);
    return sampleSummary({
      entryId,
      title: row.title,
      titleSource: 'ai',
      cwd: row.cwd,
      createdAt: iso(now - row.startedHoursAgo * HOUR),
      lastActivityAt,
      status: sampleStatusFacts(row.status),
      // The header shows `model ?? modelSetting`: null keeps it at "opus" instead of the full id, so
      // the title fits at 1440 px (the init below carries the full id, so no model badges appear).
      model: null,
      modelSetting: row.modelSetting,
      permissionMode: 'default',
      context: gauge(row.model, row.tokens, row.maxTokens, lastActivityAt),
      sessionId: `5b7c${entryId.slice(-4)}-3e1d-4c8a-9f2b-6d0e1a2b3c4d`,
      cliVersion: CLI_VERSION,
      lastResultExcerpt: null,
      ...row.extra,
    });
  });
  const archived = ARCHIVED_ROWS.map((row, index) =>
    sampleSummary({
      entryId: ARCHIVED[index] ?? sampleId('en', 0x690),
      title: row.title,
      titleSource: 'ai',
      cwd: row.cwd,
      archived: true,
      createdAt: iso(now - row.days * 24 * HOUR - 2 * HOUR),
      lastActivityAt: iso(now - row.days * 24 * HOUR),
      status: sampleStatusFacts({ runState: 'sleeping' }),
      model: SONNET,
      modelSetting: 'sonnet',
      context: null,
      cliVersion: CLI_VERSION,
      lastResultExcerpt: null,
    }),
  );
  return [...live, ...archived];
}

function toolCallWith(items: readonly TranscriptItem[], decisionId: string): ToolCallItem | undefined {
  return items.find(
    (item): item is ToolCallItem => item.kind === 'tool_call' && item.decision?.decisionId === decisionId,
  );
}

function decisionsOf(key: ShowcaseKey, items: readonly TranscriptItem[], now: number): Decision[] {
  const entryId = SHOWCASE_ENTRIES[key];
  const conversationId = sampleId('cv', 0x681 + Object.keys(SHOWCASE_ENTRIES).indexOf(key));
  if (key === 'lighthouse') {
    const call = toolCallWith(items, SHOWCASE_DECISION_IDS.lighthouse);
    return [
      {
        id: SHOWCASE_DECISION_IDS.lighthouse,
        entryId,
        conversationId,
        toolUseId: call?.toolUseId ?? 'toolu_01lighthouse',
        requester: { kind: 'main' },
        createdAt: call?.at ?? iso(now - 2 * MINUTE),
        state: 'open',
        toolName: 'Bash',
        kind: 'permission',
        input: { command: 'pnpm build', description: 'Produktionsbuild erstellen' },
        inputTruncated: null,
        title: null,
        displayName: 'Bash',
        description: 'Produktionsbuild erstellen',
        decisionReason: null,
        decisionReasonType: 'other',
        blockedPath: null,
        mcpServer: null,
        offer: {
          rules: [{ toolName: 'Bash', ruleContent: 'pnpm build' }],
          directories: [],
          ruleDestinations: ['session', 'localSettings', 'projectSettings', 'userSettings'],
          acceptEdits: true,
          defaultToNo: false,
        },
      },
    ];
  }
  if (key === 'rateLimit') {
    const call = toolCallWith(items, SHOWCASE_DECISION_IDS.planV2);
    return [
      {
        id: SHOWCASE_DECISION_IDS.planV2,
        entryId,
        conversationId,
        toolUseId: call?.toolUseId ?? 'toolu_01ratelimit',
        requester: { kind: 'main' },
        createdAt: call?.at ?? iso(now - 4 * MINUTE),
        state: 'open',
        toolName: 'ExitPlanMode',
        kind: 'plan',
        plan: PLAN_V2,
        planFilePath: PLAN_FILE,
        version: 2,
        previousVersionPlan: PLAN_V1,
        approveModes: ['default', 'acceptEdits', 'auto'],
      },
    ];
  }
  return [];
}

const MODELS = [
  sampleModelOption({
    value: 'opus',
    displayName: 'Opus',
    description: 'Opus 5.5 · most capable for complex work',
  }),
  sampleModelOption({
    value: 'sonnet',
    displayName: 'Sonnet',
    description: 'Sonnet 5.5 · best for everyday tasks',
  }),
  sampleModelOption({
    value: 'haiku',
    displayName: 'Haiku',
    description: 'Haiku 5.5 · fastest for quick answers',
  }),
];

function detailPatch(key: ShowcaseKey, now: number): Partial<SessionDetail> {
  switch (key) {
    case 'paypal':
      return {
        todos: {
          source: 'todo_write',
          items: [
            {
              id: '0',
              content: 'PayPal-Adapter anlegen',
              status: 'completed',
              activeForm: 'Lege PayPal-Adapter an',
            },
            {
              id: '1',
              content: 'Button im Zahlschritt einbauen',
              status: 'completed',
              activeForm: 'Baue Button ein',
            },
            {
              id: '2',
              content: 'Checkout-Tests ausführen',
              status: 'in_progress',
              activeForm: 'Führe Checkout-Tests aus',
            },
            {
              id: '3',
              content: 'Sandbox-Bestellung end-to-end prüfen',
              status: 'pending',
              activeForm: 'Prüfe Sandbox-Bestellung',
            },
          ],
          updatedAt: iso(now - 40_000),
          toolUseId: 'toolu_01paypal003',
        },
      };
    case 'rateLimit':
      return { latestPlanVersion: 2 };
    case 'push':
      return {
        backgroundTasks: [
          {
            taskId: 'task_events_scan',
            taskType: 'local_agent',
            description: 'Stellen finden, an denen Termine entstehen',
            subagentType: 'Explore',
            parentTaskId: null,
            ambient: false,
          },
        ],
      };
    default:
      return {};
  }
}

function snapshots(now: number, list: readonly SessionSummary[]): SessionSnapshot[] {
  const archived = ARCHIVED.map((entryId, index) =>
    sampleSessionSnapshot({
      entryId,
      seq: 0,
      items: [],
      detail: sampleDetail({
        entryId,
        conversationId: sampleId('cv', 0x691 + index),
        conversations: [],
        init: null,
        models: MODELS,
      }),
    }),
  );
  return [...liveSnapshots(now, list), ...archived];
}

function liveSnapshots(now: number, list: readonly SessionSummary[]): SessionSnapshot[] {
  const modelOf = new Map(rows(now).map((row) => [row.key, row.model]));
  return (Object.keys(SHOWCASE_ENTRIES) as ShowcaseKey[]).map((key, index) => {
    const entryId = SHOWCASE_ENTRIES[key];
    const summary = list.find((candidate) => candidate.entryId === entryId);
    const items = SHOWCASE_TRANSCRIPTS[key](now);
    const conversationId = sampleId('cv', 0x681 + index);
    const startedAt = summary?.createdAt ?? iso(now - HOUR);
    return sampleSessionSnapshot({
      entryId,
      seq: 0,
      items,
      decisions: decisionsOf(key, items, now),
      detail: sampleDetail({
        entryId,
        conversationId,
        conversations: [
          sampleConversation({
            id: conversationId,
            sessionId: summary?.sessionId ?? null,
            startedAt,
            lastOrder: items.at(-1)?.order ?? 0,
          }),
        ],
        init: {
          sessionId: summary?.sessionId ?? `5b7c${entryId.slice(-4)}-3e1d-4c8a-9f2b-6d0e1a2b3c4d`,
          cwd: summary?.cwd ?? SHOWCASE_ROOTS.shop,
          model: modelOf.get(key) ?? SONNET,
          permissionMode: summary?.permissionMode ?? 'default',
          apiKeySource: 'none',
          cliVersion: CLI_VERSION,
          tools: [
            'Bash',
            'PowerShell',
            'Read',
            'Write',
            'Edit',
            'Glob',
            'Grep',
            'Agent',
            'TodoWrite',
            'ExitPlanMode',
          ],
          slashCommands: ['clear', 'compact', 'rename', 'review'],
          terminalSlashCommands: [],
          mcpServers: [],
          skills: [],
          agents: ['general-purpose', 'Explore', 'Plan'],
          plugins: [],
          capabilities: ['msg_lifecycle_v1'],
          outputStyle: 'default',
          fastModeState: null,
          effort: summary?.effort ?? null,
        },
        models: MODELS,
        ...detailPatch(key, now),
      }),
    });
  });
}

function hostState(now: number, settings: Settings): HostState {
  return sampleHostState({
    serverVersion: '0.4.0',
    sdkVersion: '0.3.322',
    sdkClaudeCodeVersion: '2.1.322',
    dataDirLabel: '%LOCALAPPDATA%\\Parallax',
    dev: false,
    backend: 'sdk',
    port: 4711,
    nativeNotifications: true,
    systemIntegration: true,
    // German, light/dark from the system (the screenshot script emulates the color scheme).
    settings: { ...settings, language: 'de', theme: 'system', transcriptView: 'compact' },
    profiles: [
      sampleProfileSummary({
        claude: sampleClaudeInstallStatus({ version: CLI_VERSION, checkedAt: iso(now - 3 * HOUR) }),
        entryCount: 11,
      }),
    ],
    accountLimits: {
      standard: sampleRateLimitInfo({
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 0.34,
        resetsAt: iso(now + 2 * HOUR + 23 * MINUTE),
        windows: {
          five_hour: { utilization: 0.34, resetsAt: iso(now + 2 * HOUR + 23 * MINUTE) },
          seven_day: { utilization: 0.61, resetsAt: iso(now + 3 * 24 * HOUR + 5 * HOUR) },
        },
        at: iso(now - MINUTE),
      }),
    },
  });
}

export interface ShowcaseData {
  hostState: HostState;
  summaries: SessionSummary[];
  sessions: SessionSnapshot[];
}

/** The scenario data (FakeHost options); schema-valid (playground.test.tsx, showcase.test.tsx). */
export function showcaseData(now: number, settings: Settings): ShowcaseData {
  const list = summaries(now);
  return { hostState: hostState(now, settings), summaries: list, sessions: snapshots(now, list) };
}

// ---- per-host data the FakeHost keeps outside the snapshots ----

function sessionFile(
  path: string,
  ops: SessionFileOp[],
  minutesAgo: number,
  count: number,
  now: number,
  conversationId: SessionFile['conversationId'],
): SessionFile {
  return {
    path,
    ops,
    count,
    firstAt: iso(now - (minutesAgo + 6) * MINUTE),
    lastAt: iso(now - minutesAgo * MINUTE),
    lastToolUseId: null,
    conversationId,
  };
}

export function showcasePlanVersions(now: number): { info: PlanVersionInfo; text: string }[] {
  const conversationId = sampleId('cv', 0x684);
  return [
    {
      info: {
        version: 1,
        decisionId: SHOWCASE_DECISION_IDS.planV1,
        conversationId,
        createdAt: iso(now - 25 * MINUTE),
        resolvedAt: iso(now - 8 * MINUTE),
        outcome: { type: 'plan_revised' },
        planFilePath: PLAN_FILE,
        stored: true,
      },
      text: PLAN_V1,
    },
    {
      info: {
        version: 2,
        decisionId: SHOWCASE_DECISION_IDS.planV2,
        conversationId,
        createdAt: iso(now - 4 * MINUTE),
        resolvedAt: null,
        outcome: null,
        planFilePath: PLAN_FILE,
        stored: true,
      },
      text: PLAN_V2,
    },
  ];
}

/**
 * The FakeHost parts outside the snapshots: plan versions (plan.list/plan.read) and the "Files of
 * this session" index of the featured sessions. Called right after the scenario starts.
 */
export function prepareShowcaseHost(host: FakeHost, now: number): void {
  host.planVersions = showcasePlanVersions(now);
  const shopConversation = sampleId('cv', 0x681);
  host.sessionFiles.set(SHOWCASE_ENTRIES.paypal, [
    sessionFile(SHOWCASE_FILE_PATHS.paymentStep, ['read', 'edited'], 4, 2, now, shopConversation),
    sessionFile(SHOWCASE_FILE_PATHS.paypal, ['written'], 5, 1, now, shopConversation),
    sessionFile(
      `${SHOWCASE_ROOTS.shop}\\src\\app\\checkout\\useCheckout.ts`,
      ['read'],
      6,
      1,
      now,
      shopConversation,
    ),
    sessionFile(SHOWCASE_FILE_PATHS.registry, ['read'], 6, 1, now, shopConversation),
  ]);
  const appConversation = sampleId('cv', 0x687);
  host.sessionFiles.set(SHOWCASE_ENTRIES.push, [
    sessionFile(SHOWCASE_FILE_PATHS.settingsScreen, ['edited'], 5, 1, now, appConversation),
    sessionFile(SHOWCASE_FILE_PATHS.reminder, ['written'], 12, 1, now, appConversation),
    sessionFile(SHOWCASE_FILE_PATHS.event, ['read'], 18, 1, now, appConversation),
    sessionFile(SHOWCASE_FILE_PATHS.pubspec, ['read'], 18, 1, now, appConversation),
  ]);
}

/** Entry ids of every showcase session, archived ones included (tests). */
export const SHOWCASE_ALL_ENTRIES: readonly EntryId[] = [...Object.values(SHOWCASE_ENTRIES), ...ARCHIVED];
