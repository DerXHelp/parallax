import { LOCAL_HOST_ID, makeSessionKey, type EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import type {
  Decision,
  QueuedPrompt,
  SessionSummary,
  ToolCallItem,
  TranscriptItem,
  UserMessageItem,
} from '@shared/model';
import type { SessionSnapshot } from '@shared/protocol';
import {
  sampleBlobId,
  sampleDecisions,
  sampleDetail,
  sampleId,
  sampleItems,
  sampleQueuedPrompt,
  sampleSessionSnapshot,
  sampleStatusFacts,
  sampleSummary,
  sampleSystemItems,
  sampleTime,
  sampleUuid,
} from '@shared/samples';

/**
 * Playground data of the transcript demos (dev only, `playground.tsx`): sessions built from
 * `@shared/samples` with fixed ids, served by the FakeHost. Every demo session has its own entry.
 */

export const DEMO_ENTRIES = {
  overview: sampleId('en', 201),
  streaming: sampleId('en', 202),
  large: sampleId('en', 203),
  system: sampleId('en', 204),
  plan: sampleId('en', 205),
  subagent: sampleId('en', 206),
  long: sampleId('en', 207),
  security: sampleId('en', 208),
  queue: sampleId('en', 209),
} as const;

export type DemoEntry = keyof typeof DEMO_ENTRIES;

export function demoSessionKey(entry: DemoEntry): string {
  return makeSessionKey(LOCAL_HOST_ID, DEMO_ENTRIES[entry]);
}

export interface DemoSession {
  summary: SessionSummary;
  snapshot: SessionSnapshot;
}

const ESC = '\u001b';

/** Order counter per session (orders strictly increase, A.3). */
function counter(start = 1) {
  let next = start;
  return () => next++;
}

function snapshotOf(
  entryId: EntryId,
  items: TranscriptItem[],
  options: { decisions?: Decision[]; queue?: QueuedPrompt[] } = {},
): SessionSnapshot {
  return sampleSessionSnapshot({
    entryId,
    seq: 0,
    items,
    hasEarlier: false,
    decisions: options.decisions ?? [],
    detail: sampleDetail({ entryId, queue: options.queue ?? [] }),
  });
}

function summaryOf(entryId: EntryId, title: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return sampleSummary({ entryId, title, ...patch });
}

function user(
  id: string,
  order: number,
  text: string,
  patch: Partial<UserMessageItem> = {},
): UserMessageItem {
  return sampleItems.userMessage({
    id,
    order,
    at: sampleTime(order),
    text: { text, truncated: null },
    ...patch,
  });
}

function tool(
  messageId: string,
  blockIndex: number,
  order: number,
  patch: Partial<ToolCallItem> & Pick<ToolCallItem, 'toolName' | 'input'>,
): ToolCallItem {
  return sampleItems.toolCall({
    id: `${messageId}:${String(blockIndex)}`,
    messageId,
    blockIndex,
    order,
    at: sampleTime(order),
    toolUseId: `toolu_${messageId}_${String(blockIndex)}`,
    ...patch,
  });
}

function textResult(
  text: string,
  patch: Partial<NonNullable<ToolCallItem['result']>> = {},
): ToolCallItem['result'] {
  return {
    isError: false,
    content: [{ type: 'text', text: { text, truncated: null } }],
    structured: null,
    structuredTruncated: null,
    at: sampleTime(0),
    ...patch,
  };
}

const OVERVIEW_MARKDOWN = [
  'I refactored the **sync module** and ran the tests. Summary:',
  '',
  '1. `applySeqOps` now skips ops it has already applied.',
  '2. Gaps trigger exactly one re-subscribe.',
  '',
  '| File | Change |',
  '|---|---|',
  '| `src/shared/sync.ts` | gap detection |',
  '| `src/web/state/connection.ts` | one `subscribe` per gap |',
  '',
  '```ts',
  'export function applySeqOps(state: SessionViewState, ops: readonly SeqOp[]) {',
  '  const fresh = ops.filter((o) => o.seq > state.seq);',
  '  return { state, gap: false }; // simplified',
  '}',
  '```',
  '',
  '> All 1451 tests pass. See [the sync docs](https://example.com/docs/sync) for details.',
  '',
  '- [x] gap detection',
  '- [ ] replay metrics',
].join('\n');

const VITEST_OUTPUT = [
  `${ESC}[1m${ESC}[46m RUN ${ESC}[49m${ESC}[22m ${ESC}[36mv5.0.4${ESC}[39m`,
  '',
  ` ${ESC}[32m✓${ESC}[39m src/shared/sync.test.ts ${ESC}[2m(42 tests)${ESC}[22m ${ESC}[33m18ms${ESC}[39m`,
  ` ${ESC}[32m✓${ESC}[39m src/web/state/connection.test.ts ${ESC}[2m(61 tests)${ESC}[22m ${ESC}[33m240ms${ESC}[39m`,
  ` ${ESC}[31m×${ESC}[39m src/web/state/hooks.test.tsx ${ESC}[2m(1 failed)${ESC}[22m`,
  '',
  `${ESC}[1m Test Files ${ESC}[22m ${ESC}[1m${ESC}[32m2 passed${ESC}[39m${ESC}[22m${ESC}[90m | ${ESC}[39m${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m`,
  `${ESC}]8;;https://example.com${ESC}\\hyperlink text${ESC}]8;;${ESC}\\ ${ESC}[2Kdone`,
].join('\n');

function overviewSession(): DemoSession {
  const entryId = DEMO_ENTRIES.overview;
  const order = counter();
  const items: TranscriptItem[] = [
    user('px:ov:prompt', order(), 'Refactor the sync module and run the tests. Keep it short.'),
    sampleItems.thinking({
      id: 'msg_ov1:0',
      messageId: 'msg_ov1',
      order: order(),
      text: {
        text: 'The user wants a refactoring. First read the module, then edit, then run the tests.',
        truncated: null,
      },
    }),
    tool('msg_ov1', 1, order(), {
      toolName: 'Read',
      input: { file_path: 'D:\\work\\parallax\\src\\shared\\sync.ts', offset: 170, limit: 4 },
      result: textResult(
        '170\texport function applySeqOps(\n171\t  state: SessionViewState,\n172\t  ops: readonly SeqOp[],\n173\t): { state: SessionViewState; gap: boolean } {',
        {
          structured: {
            type: 'text',
            file: {
              filePath: 'D:\\work\\parallax\\src\\shared\\sync.ts',
              numLines: 4,
              startLine: 170,
              totalLines: 211,
            },
          },
        },
      ),
    }),
    tool('msg_ov2', 0, order(), {
      toolName: 'Edit',
      input: {
        file_path: 'D:\\work\\parallax\\src\\shared\\sync.ts',
        old_string: '  const fresh = ops;\n  return apply(fresh);',
        new_string:
          '  const fresh = ops.filter((o) => o.seq > state.seq);\n  if (fresh.length === 0) return { state, gap: false };\n  return apply(fresh);',
        replace_all: false,
      },
      result: textResult('The file D:\\work\\parallax\\src\\shared\\sync.ts has been updated successfully.', {
        structured: {
          filePath: 'D:\\work\\parallax\\src\\shared\\sync.ts',
          structuredPatch: [
            {
              oldStart: 182,
              oldLines: 4,
              newStart: 182,
              newLines: 5,
              lines: [
                '   ops: readonly SeqOp[],',
                ' ): { state: SessionViewState; gap: boolean } {',
                '-  const fresh = ops;',
                '+  const fresh = ops.filter((o) => o.seq > state.seq);',
                '+  if (fresh.length === 0) return { state, gap: false };',
                '   return apply(fresh);',
              ],
            },
          ],
          userModified: false,
          replaceAll: false,
        },
      }),
      decision: {
        decisionId: sampleId('dc', 201),
        kind: 'permission',
        planVersion: null,
        outcome: { type: 'allowed', remember: 'session', acceptEdits: true },
      },
    }),
    tool('msg_ov2', 1, order(), {
      toolName: 'Edit',
      input: {
        file_path: 'D:\\work\\parallax\\docs\\architecture.md',
        old_string: 'Replay overlap is skipped.',
        new_string: 'Replay overlap is skipped; a gap re-subscribes once.',
      },
      // History form: no structured result (A.3) – the diff falls back to jsdiff.
      result: textResult('The file has been updated successfully.'),
    }),
    tool('msg_ov3', 0, order(), {
      toolName: 'Write',
      input: {
        file_path: 'D:\\work\\parallax\\src\\shared\\gap.ts',
        content:
          '/** Gap detection for seq ops. */\nexport function hasGap(seqs: readonly number[], from: number): boolean {\n  return seqs.some((seq, i) => seq !== from + 1 + i);\n}\n',
      },
      result: textResult('File created successfully at: D:\\work\\parallax\\src\\shared\\gap.ts', {
        structured: {
          type: 'create',
          filePath: 'D:\\work\\parallax\\src\\shared\\gap.ts',
          structuredPatch: [],
        },
      }),
    }),
    tool('msg_ov4', 0, order(), {
      toolName: 'Bash',
      input: { command: 'pnpm exec vitest run src/shared src/web/state', description: 'Run the sync tests' },
      result: textResult(VITEST_OUTPUT, {
        structured: { interrupted: false, isImage: false, noOutputExpected: false },
      }),
      elapsedSeconds: 4,
    }),
    tool('msg_ov4', 1, order(), {
      toolName: 'PowerShell',
      input: { command: 'Get-ChildItem -Name src\\shared', description: 'List shared contracts' },
      result: textResult('common.ts\r\nerrors.ts\r\nmodel.ts\r\nprotocol.ts\r\nsync.ts', {
        structured: { interrupted: false, isImage: false },
      }),
      decision: {
        decisionId: sampleId('dc', 202),
        kind: 'permission',
        planVersion: null,
        outcome: { type: 'denied', withMessage: true, interrupt: false },
      },
      status: 'denied',
    }),
    tool('msg_ov5', 0, order(), {
      toolName: 'Grep',
      input: { pattern: 'applySeqOps', path: 'D:\\work\\parallax\\src', output_mode: 'files_with_matches' },
      result: textResult(
        'Found 3 files\nD:\\work\\parallax\\src\\shared\\sync.ts\nD:\\work\\parallax\\src\\web\\state\\connection.ts\nD:\\work\\parallax\\src\\server\\sync\\hub.ts',
        {
          structured: {
            mode: 'files_with_matches',
            numFiles: 3,
            filenames: [
              'D:\\work\\parallax\\src\\shared\\sync.ts',
              'D:\\work\\parallax\\src\\web\\state\\connection.ts',
              'D:\\work\\parallax\\src\\server\\sync\\hub.ts',
            ],
          },
        },
      ),
    }),
    tool('msg_ov5', 1, order(), {
      toolName: 'Grep',
      input: { pattern: 'gap', path: 'D:\\work\\parallax\\src\\shared', output_mode: 'content' },
      // History form: CLI text only.
      result: textResult(
        'D:\\work\\parallax\\src\\shared\\sync.ts:177:  { state: SessionViewState; gap: boolean } {\nD:\\work\\parallax\\src\\shared\\sync.ts:185:  if (!contiguous) return { state, gap: true };\nD:\\work\\parallax\\src\\shared\\sync.test.ts:40:  it("reports a gap", () => {',
      ),
    }),
    tool('msg_ov5', 2, order(), {
      toolName: 'Glob',
      input: { pattern: '**/*.test.ts', path: 'D:\\work\\parallax\\src\\shared' },
      result: textResult(
        'D:\\work\\parallax\\src\\shared\\sync.test.ts\nD:\\work\\parallax\\src\\shared\\model.test.ts',
        {
          structured: {
            filenames: [
              'D:\\work\\parallax\\src\\shared\\sync.test.ts',
              'D:\\work\\parallax\\src\\shared\\model.test.ts',
            ],
            numFiles: 2,
            truncated: false,
          },
        },
      ),
    }),
    tool('msg_ov6', 0, order(), {
      toolName: 'mcp__docs__search',
      input: { query: 'ring buffer replay', limit: 3 },
      result: textResult('3 documents found.', {
        structured: {
          results: [
            { title: 'Sync protocol', score: 0.92 },
            { title: 'Ring buffer', score: 0.81 },
          ],
        },
      }),
    }),
    tool('msg_ov6', 1, order(), {
      toolName: 'TodoWrite',
      input: {
        todos: [
          { content: 'Read the sync module', status: 'completed', activeForm: 'Reading the sync module' },
          { content: 'Fix the gap detection', status: 'completed', activeForm: 'Fixing the gap detection' },
          { content: 'Add replay metrics', status: 'in_progress', activeForm: 'Adding replay metrics' },
          { content: 'Update the docs', status: 'pending', activeForm: 'Updating the docs' },
        ],
      },
      result: textResult('Todos have been modified successfully.'),
    }),
    tool('msg_ov7', 0, order(), {
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Should the replay metrics be exported?',
            header: 'Metrics',
            multiSelect: false,
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      result: textResult('The user answered: "Should the replay metrics be exported?"="Yes"', {
        structured: {
          answers: { 'Should the replay metrics be exported?': 'Yes' },
          annotations: { 'Should the replay metrics be exported?': { notes: 'Only in dev builds.' } },
        },
      }),
      decision: {
        decisionId: sampleId('dc', 203),
        kind: 'question',
        planVersion: null,
        outcome: { type: 'answered' },
      },
    }),
    sampleItems.assistantText({
      id: 'msg_ov8:0',
      messageId: 'msg_ov8',
      blockIndex: 0,
      order: order(),
      model: 'claude-sonnet-5-5',
      text: OVERVIEW_MARKDOWN,
    }),
    sampleItems.turnResult({
      id: sampleUuid(2010),
      order: order(),
      durationMs: 48_200,
      durationApiMs: 41_000,
      numTurns: 9,
      usage: { input: 1200, output: 3400, cacheRead: 182_000, cacheCreation: 5600 },
      costUsdTotal: 0.1834,
      costUsdTurn: 0.1834,
      permissionDenials: 1,
      userMessageUuids: ['px:ov:prompt'],
    }),
  ];
  return {
    // An API-key profile: the turn footer shows costs (B "Kosten nur bei API-Key-Profilen").
    summary: summaryOf(entryId, 'Transcript overview', { apiKeySource: 'ANTHROPIC_API_KEY' }),
    snapshot: snapshotOf(entryId, items),
  };
}

function largeSession(): DemoSession {
  const entryId = DEMO_ENTRIES.large;
  const lines = Array.from(
    { length: 1800 },
    (_, i) => `line ${String(i + 1).padStart(5, '0')}  ${'·'.repeat(i % 40)}`,
  );
  const shown = lines.join('\n');
  return {
    summary: summaryOf(entryId, 'Large output'),
    snapshot: snapshotOf(entryId, [
      user('px:large:prompt', 1, 'Print the build log.'),
      tool('msg_large', 0, 2, {
        toolName: 'Bash',
        input: { command: 'type build.log', description: 'Print the build log' },
        result: {
          isError: false,
          content: [
            {
              type: 'text',
              text: { text: shown, truncated: { totalChars: 250_000, blobId: sampleBlobId(31) } },
            },
          ],
          structured: { interrupted: false, isImage: false },
          structuredTruncated: null,
          at: sampleTime(3),
        },
      }),
      tool('msg_large', 1, 3, {
        toolName: 'Write',
        input: { file_path: 'D:\\work\\big\\data.csv', content: `id,value\n${'1,2\n'.repeat(200)}` },
        inputTruncated: { totalChars: 120_000, blobId: sampleBlobId(32) },
        result: textResult('File created successfully at: D:\\work\\big\\data.csv', {
          structured: { type: 'create', structuredPatch: [] },
        }),
      }),
    ]),
  };
}

/** Full texts of the large-output demo (the playground has no blob server). */
export function demoBlobText(blobId: string): string | null {
  if (blobId === sampleBlobId(31)) {
    return Array.from(
      { length: 9000 },
      (_, i) => `line ${String(i + 1).padStart(5, '0')}  ${'·'.repeat(i % 40)}`,
    ).join('\n');
  }
  if (blobId === sampleBlobId(32)) {
    return JSON.stringify({
      file_path: 'D:\\work\\big\\data.csv',
      content: `id,value\n${'1,2\n'.repeat(3000)}`,
    });
  }
  return null;
}

function systemSession(): DemoSession {
  const entryId = DEMO_ENTRIES.system;
  const items: TranscriptItem[] = [
    sampleSystemItems.conversation_reset({ order: 1 }),
    user('px:sys:prompt', 2, 'Continue with the migration.'),
    sampleSystemItems.memory_recall({
      order: 3,
      memories: [
        {
          path: 'CLAUDE.md',
          scope: 'project',
          content: { text: '# Rules\n- German docs\n- English code', truncated: null },
        },
        { path: '~/.claude/CLAUDE.md', scope: 'user', content: null },
      ],
    }),
    sampleSystemItems.hook({ order: 4, output: { text: 'lint ok', truncated: null } }),
    sampleSystemItems.api_retry({ order: 5 }),
    sampleSystemItems.api_retry({ id: sampleUuid(1101), order: 6, attempt: 2, active: false }),
    sampleSystemItems.rate_limit({ order: 7 }),
    sampleSystemItems.rate_limit({
      id: sampleUuid(1102),
      order: 8,
      info: { ...sampleSystemItems.rate_limit().info, status: 'rejected', utilization: 1 },
    }),
    sampleSystemItems.notification({ order: 9, text: 'Claude is waiting for your input' }),
    sampleSystemItems.informational({ order: 10 }),
    sampleSystemItems.informational({
      id: sampleUuid(1103),
      order: 11,
      level: 'warning',
      text: { text: 'Stop hook blocked the turn: tests failing.', truncated: null },
      preventContinuation: true,
    }),
    sampleSystemItems.permission_denied({ order: 12 }),
    sampleSystemItems.local_command_output({
      order: 13,
      text: { text: `${ESC}[32mCompacted${ESC}[39m (ctrl+o to see full summary)`, truncated: null },
    }),
    sampleSystemItems.model_fallback({ order: 14 }),
    sampleSystemItems.interrupted({ order: 15 }),
    sampleSystemItems.task_notification({ order: 16 }),
    sampleSystemItems.error({ order: 17 }),
    sampleSystemItems.error({ id: sampleUuid(1104), order: 18, error: makeError('API_OVERLOADED') }),
    sampleSystemItems.unknown({ order: 19 }),
    sampleSystemItems.compact_boundary({ order: 20 }),
    sampleSystemItems.compact_boundary({
      id: sampleUuid(1105),
      order: 21,
      trigger: 'manual',
      preTokens: null,
      postTokens: null,
    }),
    sampleItems.turnResult({
      id: sampleUuid(2040),
      order: 22,
      outcome: 'interrupted',
      subtype: 'error_during_execution',
    }),
    sampleItems.turnResult({ id: sampleUuid(2041), order: 23, synthetic: true }),
    sampleItems.turnResult({
      id: sampleUuid(2042),
      order: 24,
      outcome: 'error',
      subtype: 'error_max_turns',
      errors: ['Reached the maximum number of turns'],
    }),
  ];
  return { summary: summaryOf(entryId, 'System items'), snapshot: snapshotOf(entryId, items) };
}

const PLAN_V1 =
  '## Plan\n\n1. Add `hasGap()` to `src/shared/sync.ts`.\n2. Use it in the web client.\n3. Run `pnpm check`.';
const PLAN_V2 = `${PLAN_V1}\n4. Document the change in \`docs/architecture.md\`.`;

function planSession(): DemoSession {
  const entryId = DEMO_ENTRIES.plan;
  const decisionOpen = sampleDecisions.plan({
    id: sampleId('dc', 251),
    entryId,
    toolUseId: 'toolu_msg_plan4_0',
    plan: PLAN_V2,
    version: 3,
  });
  const decisionExpired = sampleDecisions.plan({
    id: sampleId('dc', 252),
    entryId,
    toolUseId: 'toolu_msg_plan5_0',
    plan: PLAN_V2,
    version: 4,
    state: 'expired',
  });
  const planFilePath = 'C:\\Users\\user\\.claude\\plans\\gap-detection.md';
  const items: TranscriptItem[] = [
    user('px:plan:prompt', 1, 'Plan the gap detection first.', { priority: 'next' }),
    tool('msg_plan1', 0, 2, {
      toolName: 'ExitPlanMode',
      model: 'claude-sonnet-5-5',
      input: { plan: PLAN_V1, planFilePath },
      status: 'denied',
      result: textResult('Feedback from the user: also document the change.', { isError: true }),
      decision: {
        decisionId: sampleId('dc', 253),
        kind: 'plan',
        planVersion: 1,
        outcome: { type: 'plan_revised' },
      },
    }),
    tool('msg_plan2', 0, 3, {
      toolName: 'ExitPlanMode',
      model: 'claude-sonnet-5-5',
      input: { plan: PLAN_V2, planFilePath },
      status: 'done',
      result: textResult('User has approved your plan.', {
        structured: {
          plan: `${PLAN_V2}\n5. (edited) Keep the old API for one release.`,
          planWasEdited: true,
        },
      }),
      decision: {
        decisionId: sampleId('dc', 254),
        kind: 'plan',
        planVersion: 2,
        outcome: { type: 'plan_approved', mode: 'acceptEdits', edited: true },
      },
    }),
    tool('msg_plan3', 0, 4, {
      toolName: 'ExitPlanMode',
      input: { plan: PLAN_V1, planFilePath },
      status: 'done',
      // History form: no decision ref (decisions are live only, A.3).
      result: textResult('User has approved your plan.'),
    }),
    tool('msg_plan4', 0, 5, {
      toolName: 'ExitPlanMode',
      model: 'claude-sonnet-5-5',
      input: { plan: PLAN_V2, planFilePath },
      status: 'awaiting_decision',
      result: null,
      decision: { decisionId: decisionOpen.id, kind: 'plan', planVersion: 3, outcome: null },
    }),
    tool('msg_plan5', 0, 6, {
      toolName: 'ExitPlanMode',
      model: 'claude-sonnet-5-5',
      input: { plan: PLAN_V2, planFilePath },
      status: 'awaiting_decision',
      result: null,
      decision: { decisionId: decisionExpired.id, kind: 'plan', planVersion: 4, outcome: null },
    }),
    tool('msg_perm', 0, 7, {
      toolName: 'Bash',
      input: { command: 'mkdir build', description: 'Create build folder' },
      status: 'awaiting_decision',
      result: null,
      decision: { decisionId: sampleId('dc', 255), kind: 'permission', planVersion: null, outcome: null },
    }),
  ];
  const permission = sampleDecisions.permission({
    id: sampleId('dc', 255),
    entryId,
    toolUseId: 'toolu_msg_perm_0',
  });
  return {
    summary: summaryOf(entryId, 'Plan cards', {
      status: sampleStatusFacts({
        runState: 'idle',
        decisions: { permission: 1, question: 0, plan: 1, oldestKind: 'plan', expired: 1 },
      }),
    }),
    snapshot: snapshotOf(entryId, items, { decisions: [decisionOpen, decisionExpired, permission] }),
  };
}

function subagentSession(now: number): DemoSession {
  const entryId = DEMO_ENTRIES.subagent;
  const agentDone = 'toolu_agent_done';
  const agentRunning = 'toolu_agent_running';
  const items: TranscriptItem[] = [
    user('px:sub:prompt', 1, 'Find all usages of applySeqOps with a subagent.'),
    tool('msg_sub1', 0, 2, {
      toolName: 'Agent',
      toolUseId: agentDone,
      input: {
        description: 'Find usages',
        subagent_type: 'Explore',
        prompt: 'Find all usages of applySeqOps in src/.',
      },
      status: 'done',
      result: textResult('Async agent launched successfully.', {
        structured: { isAsync: true, status: 'async_launched', resolvedModel: 'claude-haiku-5-5' },
      }),
      task: {
        taskId: 'task_find',
        taskType: 'local_agent',
        status: 'completed',
        description: 'Find usages',
        subagentType: 'Explore',
        isBackgrounded: true,
        summary: 'applySeqOps is used in 3 files: sync.ts, connection.ts and hub.ts.',
        usage: { totalTokens: 22_609, toolUses: 2, durationMs: 9_400 },
        startedAt: sampleTime(2),
        endedAt: sampleTime(12),
      },
    }),
    sampleItems.thinking({
      id: 'msg_child1:0',
      messageId: 'msg_child1',
      order: 3,
      parentToolUseId: agentDone,
      text: { text: 'Search with Grep, then confirm with Read.', truncated: null },
    }),
    tool('msg_child1', 1, 4, {
      toolName: 'Grep',
      parentToolUseId: agentDone,
      input: { pattern: 'applySeqOps', path: 'src' },
      result: textResult(
        'Found 3 files\nsrc/shared/sync.ts\nsrc/web/state/connection.ts\nsrc/server/sync/hub.ts',
      ),
    }),
    sampleItems.assistantText({
      id: 'msg_child2:0',
      messageId: 'msg_child2',
      blockIndex: 0,
      order: 5,
      parentToolUseId: agentDone,
      text: 'Found **3** usages.',
    }),
    tool('msg_sub2', 0, 6, {
      toolName: 'Agent',
      toolUseId: agentRunning,
      input: {
        description: 'Review the tests',
        subagent_type: 'general-purpose',
        prompt: 'Review the sync tests.',
      },
      status: 'background',
      result: textResult('Async agent launched successfully.', {
        structured: { isAsync: true, status: 'async_launched' },
      }),
      task: {
        taskId: 'task_review',
        taskType: 'local_agent',
        status: 'running',
        description: 'Review the tests',
        subagentType: 'general-purpose',
        isBackgrounded: true,
        summary: null,
        usage: null,
        startedAt: new Date(now - 42_000).toISOString(),
        endedAt: null,
      },
    }),
    tool('msg_child3', 0, 7, {
      toolName: 'Read',
      parentToolUseId: agentRunning,
      status: 'running',
      input: { file_path: 'src/shared/sync.test.ts' },
      result: null,
    }),
  ];
  return { summary: summaryOf(entryId, 'Subagents'), snapshot: snapshotOf(entryId, items) };
}

/** 1200 items: the snapshot is trimmed to LIMITS.snapshotItems, scrolling up loads earlier ones. */
function longSession(): DemoSession {
  const entryId = DEMO_ENTRIES.long;
  const items: TranscriptItem[] = [];
  const order = counter();
  for (let round = 1; items.length < 1200; round++) {
    const messageId = `msg_long${String(round)}`;
    items.push(
      user(
        `px:long:${String(round)}`,
        order(),
        `Question ${String(round)}: what is ${String(round)} squared?`,
      ),
    );
    if (round % 5 === 0) {
      items.push(
        tool(messageId, 0, order(), {
          toolName: 'Bash',
          input: {
            command: `echo $((${String(round)} * ${String(round)}))`,
            description: 'Compute the square',
          },
          result: textResult(String(round * round)),
        }),
      );
    }
    items.push(
      sampleItems.assistantText({
        id: `${messageId}:1`,
        messageId,
        blockIndex: 1,
        order: order(),
        text: `${String(round)}² = **${String(round * round)}**${round % 3 === 0 ? '\n\n```ts\nconst square = (n: number) => n * n;\n```' : ''}`,
      }),
    );
  }
  return { summary: summaryOf(entryId, 'Long transcript'), snapshot: snapshotOf(entryId, items) };
}

export const SECURITY_MARKDOWN = [
  'Raw HTML is dropped: <script>alert("xss")</script> <img src=x onerror="alert(1)"> <b>not bold</b>',
  '',
  '<div onclick="alert(1)">HTML block</div>',
  '',
  '- [javascript link](javascript:alert(1)) stays text',
  '- [data link](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) stays text',
  '- [vbscript link](vbscript:msgbox(1)) stays text',
  '- [relative link](../secrets.txt) stays text',
  '- [web link](https://example.com/docs) opens in the browser',
  '- autolink https://example.com and mail foo@example.com',
  '- image ![tracking pixel](https://example.com/pixel.png) becomes a link',
  '',
  '```html',
  '<script>alert("inside a code block is just text")</script>',
  '```',
].join('\n');

function securitySession(): DemoSession {
  const entryId = DEMO_ENTRIES.security;
  return {
    summary: summaryOf(entryId, 'Markdown security'),
    snapshot: snapshotOf(entryId, [
      user('px:sec:prompt', 1, '<img src=x onerror=alert(1)> user text is plain text, never HTML'),
      sampleItems.assistantText({
        id: 'msg_sec:0',
        messageId: 'msg_sec',
        blockIndex: 0,
        order: 2,
        text: SECURITY_MARKDOWN,
      }),
      tool('msg_sec', 1, 3, {
        toolName: 'Bash',
        input: { command: 'printf "\\e]0;evil title\\a\\e[31mred\\e[0m"' },
        result: textResult(
          `${ESC}]0;evil title\u0007${ESC}[31mred${ESC}[0m <script>alert(1)</script> ${ESC}[999;999H${ESC}[?25l`,
        ),
      }),
    ]),
  };
}

function queueSession(): DemoSession {
  const entryId = DEMO_ENTRIES.queue;
  const taken = sampleUuid(2090);
  return {
    summary: summaryOf(entryId, 'Queued prompts', { status: sampleStatusFacts({ runState: 'working' }) }),
    snapshot: snapshotOf(
      entryId,
      [
        user('px:queue:prompt', 1, 'Run the full test suite.'),
        tool('msg_queue', 0, 2, {
          toolName: 'Bash',
          input: { command: 'pnpm test', description: 'Run all tests' },
          status: 'running',
          result: null,
          elapsedSeconds: 37,
        }),
        // Item exists but the queue still lists it (race between ops): grey until the queue drops it.
        user(taken, 3, 'And then lint, please.'),
      ],
      {
        queue: [
          sampleQueuedPrompt({
            messageUuid: taken,
            text: { text: 'And then lint, please.', truncated: null },
          }),
          sampleQueuedPrompt({
            messageUuid: sampleUuid(2091),
            text: { text: 'Finally commit.', truncated: null },
          }),
          sampleQueuedPrompt({
            messageUuid: sampleUuid(2092),
            text: { text: 'Stop after the commit.', truncated: null },
            state: 'sending',
          }),
        ],
      },
    ),
  };
}

function streamingSession(): DemoSession {
  const entryId = DEMO_ENTRIES.streaming;
  return {
    summary: summaryOf(entryId, 'Streaming', { status: sampleStatusFacts({ runState: 'working' }) }),
    snapshot: snapshotOf(entryId, []),
  };
}

/** All demo sessions (built once per scenario start). */
export function demoSessions(now: number): DemoSession[] {
  return [
    overviewSession(),
    streamingSession(),
    largeSession(),
    systemSession(),
    planSession(),
    subagentSession(now),
    longSession(),
    securitySession(),
    queueSession(),
  ];
}
