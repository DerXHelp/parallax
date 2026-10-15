import type { EntryId } from '@shared/common';
import type {
  Decision,
  ModelOption,
  PlanDecision,
  QueuedPrompt,
  SessionSummary,
  TranscriptItem,
} from '@shared/model';
import type { SessionSnapshot } from '@shared/protocol';
import {
  sampleContextGauge,
  sampleDecisions,
  sampleDetail,
  sampleHostState,
  sampleId,
  sampleItems,
  sampleModelOption,
  sampleProfileSummary,
  sampleQueuedPrompt,
  sampleSessionSnapshot,
  sampleStatusFacts,
  sampleSummary,
  sampleSystemItems,
  sampleUuid,
} from '@shared/samples';
import type { StatusFacts } from '@shared/status';

/**
 * Sample sessions of WP-16 (playground demos and component tests), built only from
 * `@shared/samples` factories with fixed ids (`en_…a1` …). Every decision has its gating
 * tool call in the transcript (same `toolUseId`), so answers land in `tool_call.decision` like
 * with the real engine (FakeHost, architecture §2.3e).
 */

export const DEMO_ENTRIES = {
  permission: sampleId('en', 0xa1),
  edit: sampleId('en', 0xa2),
  question: sampleId('en', 0xa3),
  plan: sampleId('en', 0xa4),
  queue: sampleId('en', 0xa5),
  expired: sampleId('en', 0xa6),
  cautious: sampleId('en', 0xa7),
  idle: sampleId('en', 0xa8),
  working: sampleId('en', 0xa9),
  bypass: sampleId('en', 0xaa),
} as const satisfies Record<string, EntryId>;

export type DemoEntry = keyof typeof DEMO_ENTRIES;

/** Profile that allows bypass (C.3) – used by the `bypass` session. */
export const BYPASS_PROFILE_ID = sampleId('pf', 0xb1);

export const DEMO_PLAN = [
  '# Move the session registry to JSON files',
  '',
  'Replace the SQLite registry with atomic JSON files and schema versions, so a crash never leaves a half-written file.',
  '',
  '1. Add `JsonStore<T>` (temp file + rename, retry on `EPERM`)',
  '2. Migrate `sessions.json` to `schemaVersion: 1`',
  '3. Remove the SQLite dependency and its build step',
  '',
  '## Risks',
  '',
  '- A virus scanner may hold the file during the rename → retry with backoff',
  '- Old files without `schemaVersion` → load with defaults',
  '',
  '## Tests',
  '',
  '```ts',
  'await store.write({ schemaVersion: 1, entries: [] });',
  "expect(await readFile('sessions.json', 'utf8')).toContain('schemaVersion');",
  '```',
].join('\n');

export const DEMO_MODELS: ModelOption[] = [
  sampleModelOption({
    value: 'default',
    displayName: 'Default',
    description: 'Recommended for most tasks',
    supportsEffort: false,
    supportedEffortLevels: [],
  }),
  sampleModelOption({ value: 'haiku', displayName: 'Haiku', description: 'Fast and light' }),
  sampleModelOption({
    value: 'sonnet',
    displayName: 'Sonnet',
    description: 'Balanced',
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
  }),
  sampleModelOption({
    value: 'opus',
    displayName: 'Opus',
    description: 'Most capable',
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
  }),
];

function decisionCounts(decisions: readonly Decision[]): StatusFacts['decisions'] {
  const open = decisions.filter((decision) => decision.state === 'open');
  const count = (kind: Decision['kind']) => open.filter((decision) => decision.kind === kind).length;
  return {
    permission: count('permission'),
    question: count('question'),
    plan: count('plan'),
    oldestKind: open[0]?.kind ?? null,
    expired: decisions.filter((decision) => decision.state === 'expired').length,
  };
}

/** Gating tool call of a decision (same toolUseId; status awaiting_decision / interrupted). */
function gatingToolCall(decision: Decision, order: number): TranscriptItem {
  const input =
    decision.kind === 'permission'
      ? decision.input
      : decision.kind === 'plan'
        ? { plan: decision.plan, planFilePath: decision.planFilePath }
        : { questions: decision.questions.map((question) => ({ question: question.question })) };
  return sampleItems.toolCall({
    id: `msg_demo_${decision.id}:0`,
    messageId: `msg_demo_${decision.id}`,
    blockIndex: 0,
    order,
    toolUseId: decision.toolUseId,
    toolName: decision.toolName,
    input,
    status: decision.state === 'expired' ? 'interrupted' : 'awaiting_decision',
    result: null,
    parentToolUseId: decision.requester.kind === 'subagent' ? decision.requester.parentToolUseId : null,
    decision: {
      decisionId: decision.id,
      kind: decision.kind,
      planVersion: decision.kind === 'plan' ? decision.version : null,
      outcome: null,
    },
  });
}

interface DemoSessionSpec {
  title: string;
  cwd: string;
  prompt: string;
  status: Partial<StatusFacts>;
  decisions?: (entryId: EntryId) => Decision[];
  summary?: Partial<SessionSummary>;
  queue?: QueuedPrompt[];
  extraItems?: TranscriptItem[];
}

function permissionDecisions(entryId: EntryId): Decision[] {
  return [
    sampleDecisions.permission({
      entryId,
      id: sampleId('dc', 0xa11),
      toolUseId: 'toolu_demo_bash',
      input: { command: 'pnpm install --frozen-lockfile', description: 'Install dependencies' },
      description: 'Install dependencies',
      offer: {
        rules: [{ toolName: 'Bash', ruleContent: 'pnpm install --frozen-lockfile' }],
        directories: [],
        ruleDestinations: ['session', 'localSettings', 'projectSettings', 'userSettings'],
        acceptEdits: true,
        defaultToNo: false,
      },
    }),
  ];
}

function editDecisions(entryId: EntryId): Decision[] {
  return [
    sampleDecisions.permission({
      entryId,
      id: sampleId('dc', 0xa21),
      toolUseId: 'toolu_demo_edit',
      toolName: 'Edit',
      displayName: 'Edit',
      description: null,
      input: {
        file_path: 'D:\\work\\parallax\\src\\server\\store\\json-store.ts',
        old_string: 'const RETRIES = 3;',
        new_string: 'const RETRIES = 5; // virus scanners hold files longer',
        replace_all: false,
      },
      // Edit/Write only suggest setMode acceptEdits (F.3): nothing to remember.
      offer: { rules: [], directories: [], ruleDestinations: [], acceptEdits: true, defaultToNo: false },
    }),
  ];
}

function questionDecisions(entryId: EntryId): Decision[] {
  return [
    sampleDecisions.question({
      entryId,
      id: sampleId('dc', 0xa31),
      toolUseId: 'toolu_demo_question',
      questions: [
        {
          question: 'Which storage format should the registry use?',
          header: 'Format',
          multiSelect: false,
          options: [
            {
              label: 'JSON files',
              description: 'Readable, atomic via rename',
              preview: '```json\n{ "schemaVersion": 1, "entries": [] }\n```',
            },
            {
              label: 'SQLite',
              description: 'Needs a native module',
              preview: '```sql\nCREATE TABLE entries (id TEXT PRIMARY KEY);\n```',
            },
          ],
        },
        {
          question: 'Which checks should run before every commit?',
          header: 'Checks',
          multiSelect: true,
          options: [
            { label: 'Typecheck', description: 'tsc -b', preview: null },
            { label: 'Lint', description: 'eslint .', preview: null },
            { label: 'Tests', description: 'vitest run', preview: null },
          ],
        },
      ],
    }),
  ];
}

function planDecision(entryId: EntryId, n: number, p: Partial<PlanDecision> = {}): PlanDecision {
  return sampleDecisions.plan({
    entryId,
    id: sampleId('dc', n),
    toolUseId: `toolu_demo_plan_${String(n)}`,
    plan: DEMO_PLAN,
    planFilePath: 'C:\\Users\\user\\.claude\\plans\\json-registry.md',
    version: 2,
    previousVersionPlan: '# Move the session registry\n\n1. Replace SQLite',
    approveModes: ['acceptEdits', 'auto', 'default'],
    ...p,
  });
}

function queueDecisions(entryId: EntryId): Decision[] {
  return [
    sampleDecisions.permission({
      entryId,
      id: sampleId('dc', 0xa51),
      toolUseId: 'toolu_demo_queue_bash',
      createdAt: '2026-10-15T08:00:01.000Z',
      input: { command: 'git status --porcelain', description: 'Check the working tree' },
      description: 'Check the working tree',
    }),
    sampleDecisions.question({
      entryId,
      id: sampleId('dc', 0xa52),
      toolUseId: 'toolu_demo_queue_question',
      createdAt: '2026-10-15T08:00:02.000Z',
      requester: {
        kind: 'subagent',
        agentId: 'agent_explore_1',
        description: 'Explore the store code',
        parentToolUseId: 'toolu_demo_agent',
      },
    }),
    planDecision(entryId, 0xa53, { createdAt: '2026-10-15T08:00:03.000Z', version: 1 }),
  ];
}

function expiredDecisions(entryId: EntryId): Decision[] {
  return [
    planDecision(entryId, 0xa61, { state: 'expired', createdAt: '2026-10-15T08:00:01.000Z' }),
    sampleDecisions.permission({
      entryId,
      id: sampleId('dc', 0xa62),
      toolUseId: 'toolu_demo_expired_bash',
      createdAt: '2026-10-15T08:00:02.000Z',
      state: 'expired',
    }),
  ];
}

function cautiousDecisions(entryId: EntryId): Decision[] {
  return [
    sampleDecisions.permission({
      entryId,
      id: sampleId('dc', 0xa71),
      toolUseId: 'toolu_demo_cautious',
      toolName: 'PowerShell',
      displayName: 'PowerShell',
      input: {
        command: 'Remove-Item -Recurse -Force ..\\shared-cache',
        description: 'Delete the shared cache',
      },
      description: 'Delete the shared cache',
      decisionReason: 'Path is outside the allowed working directories',
      blockedPath: 'D:\\work\\shared-cache',
      // suppressAlwaysAllowRule (no destinations) + defaultToNo (F.3).
      offer: { rules: [], directories: [], ruleDestinations: [], acceptEdits: false, defaultToNo: true },
    }),
  ];
}

const SPECS: Readonly<Record<DemoEntry, DemoSessionSpec>> = {
  permission: {
    title: 'Install the dependencies',
    cwd: 'D:\\work\\parallax',
    prompt: 'Install the dependencies and run the tests.',
    status: { runState: 'working' },
    decisions: permissionDecisions,
    summary: { context: sampleContextGauge({ percentage: 42, totalTokens: 84_000, maxTokens: 200_000 }) },
  },
  edit: {
    title: 'Raise the store retries',
    cwd: 'D:\\work\\parallax\\src\\server',
    prompt: 'Raise the retries of the JSON store.',
    status: { runState: 'working' },
    decisions: editDecisions,
  },
  question: {
    title: 'Pick the registry format',
    cwd: 'D:\\work\\parallax',
    prompt: 'Ask me before you pick a storage format.',
    status: { runState: 'working' },
    decisions: questionDecisions,
  },
  plan: {
    title: 'Plan the JSON registry',
    cwd: 'D:\\work\\parallax',
    prompt: 'Plan how to move the registry to JSON files.',
    status: { runState: 'working' },
    decisions: (entryId) => [planDecision(entryId, 0xa41)],
    summary: {
      permissionMode: 'plan',
      context: sampleContextGauge({
        percentage: 78,
        totalTokens: 156_000,
        maxTokens: 200_000,
        source: 'estimate',
      }),
    },
  },
  queue: {
    title: 'Three decisions at once',
    cwd: 'D:\\work\\parallax\\src',
    prompt: 'Check the tree, explore the store and plan the migration.',
    status: { runState: 'working' },
    decisions: queueDecisions,
  },
  expired: {
    title: 'Plan approval after restart',
    cwd: 'D:\\work\\billing',
    prompt: 'Plan the invoice export.',
    status: { runState: 'interrupted' },
    decisions: expiredDecisions,
    extraItems: [sampleSystemItems.interrupted({ order: 50 })],
  },
  cautious: {
    title: 'Clean up the shared cache',
    cwd: 'D:\\work\\parallax',
    prompt: 'Delete the old shared cache.',
    status: { runState: 'working' },
    decisions: cautiousDecisions,
  },
  idle: {
    title: 'Idle session',
    cwd: 'D:\\work\\parallax',
    prompt: 'Say OK.',
    status: { runState: 'idle' },
    summary: { context: sampleContextGauge({ percentage: 71, totalTokens: 142_000, maxTokens: 200_000 }) },
  },
  working: {
    title: 'Working with a queue',
    cwd: 'D:\\work\\parallax\\docs',
    prompt: 'Write the architecture overview.',
    status: { runState: 'working', queuedPrompts: 2 },
    queue: [
      sampleQueuedPrompt({
        messageUuid: sampleUuid(0xa91),
        text: { text: 'Also add a sequence diagram.', truncated: null },
      }),
      sampleQueuedPrompt({
        messageUuid: sampleUuid(0xa92),
        text: { text: 'And keep it under two pages.', truncated: null },
        state: 'sending',
      }),
    ],
    summary: {
      context: sampleContextGauge({
        percentage: 88,
        totalTokens: 176_000,
        maxTokens: 200_000,
        source: 'estimate',
      }),
    },
  },
  bypass: {
    title: 'Isolated sandbox',
    cwd: 'D:\\sandbox\\vm',
    prompt: 'Run the full build.',
    status: { runState: 'idle' },
    summary: { profileId: BYPASS_PROFILE_ID, permissionMode: 'bypassPermissions' },
  },
};

export interface DemoData {
  summaries: SessionSummary[];
  sessions: SessionSnapshot[];
}

/** Summaries and snapshots of the given demo sessions (default: all). */
export const DEMO_ENTRY_NAMES: readonly DemoEntry[] = [
  'permission',
  'edit',
  'question',
  'plan',
  'queue',
  'expired',
  'cautious',
  'idle',
  'working',
  'bypass',
];

export function demoData(entries: readonly DemoEntry[] = DEMO_ENTRY_NAMES): DemoData {
  const baseInit = sampleDetail().init;
  const summaries: SessionSummary[] = [];
  const sessions: SessionSnapshot[] = [];
  entries.forEach((name, index) => {
    const entryId = DEMO_ENTRIES[name];
    const spec = SPECS[name];
    const decisions = spec.decisions?.(entryId) ?? [];
    const conversationId = sampleId('cv', 0xa0 + index);
    const items: TranscriptItem[] = [
      sampleItems.userMessage({
        id: sampleUuid(0xa00 + index),
        order: 1,
        text: { text: spec.prompt, truncated: null },
      }),
      ...decisions.map((decision, i) => gatingToolCall(decision, 2 + i)),
      ...(spec.extraItems ?? []),
    ];
    summaries.push(
      sampleSummary({
        entryId,
        title: spec.title,
        cwd: spec.cwd,
        status: sampleStatusFacts({ ...spec.status, decisions: decisionCounts(decisions) }),
        ...spec.summary,
      }),
    );
    sessions.push(
      sampleSessionSnapshot({
        entryId,
        seq: 0,
        items,
        decisions: decisions.map((decision) => ({ ...decision, conversationId })),
        detail: sampleDetail({
          entryId,
          conversationId,
          models: DEMO_MODELS,
          queue: spec.queue ?? [],
          init:
            baseInit === null
              ? null
              : { ...baseInit, cwd: spec.cwd, permissionMode: spec.summary?.permissionMode ?? 'default' },
        }),
      }),
    );
  });
  return { summaries, sessions };
}

/** Host with the standard profile plus a profile that allows bypass. */
export function demoHostState() {
  return sampleHostState({
    profiles: [
      sampleProfileSummary(),
      sampleProfileSummary({
        id: BYPASS_PROFILE_ID,
        name: 'Sandbox',
        color: 'red',
        isDefault: false,
        builtin: false,
        allowsBypass: true,
      }),
    ],
  });
}
