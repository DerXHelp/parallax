/**
 * WP-65 parts of the FakeBackend (overview): the fake account's plan usage (`FakeUsage` – every
 * played `rate_limit_event` updates it, `readUsage()` answers it in the raw SDK shape, so the same
 * parser as the SdkBackend reads it), the fake title generator (`fakeTitle`, like the CLI: with
 * `persist` an existing title wins) and the keywords `fake:long-bash` (a foreground Bash that runs
 * until `backgroundTasks()` moves it to the background, or ends after FAKE_LONG_BASH_MS × speed –
 * never at speed 0) and `fake:summary` (a turn with the CLI's live sentence and turn summary while
 * the fake bridge is connected; without one the engine's fallback shows).
 */
import { z } from 'zod';
import { msg, system } from '../../sessions/normalizer/synthetic/build';
import type { FixtureEvent } from '../fixture';
import type { TitleResult, UsageWindow } from '../types';
import {
  events,
  frame,
  streamedText,
  toEvents,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
  type DslContext,
} from './dsl';
import type { FakeHistoryStore } from './history';
import { contextFor, firstWords, type Turn } from './turn';
import type { FakeOverviewOptions, FakeScriptContext } from './types';

// ---- usage ----

const HOUR_MS = 3_600_000;

const rateLimitEventSchema = z.looseObject({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.looseObject({
    rateLimitType: z.string().nullable().optional(),
    utilization: z.number().nullable().optional(),
    resetsAt: z.number().nullable().optional(),
    unifiedWindows: z
      .record(z.string(), z.looseObject({ utilization: z.number().nullable().optional(), resetsAt: z.number().nullable().optional() }))
      .nullable()
      .optional(),
  }),
});

/**
 * The plan windows of the fake account (shared by all sessions of one backend). Defaults until a
 * `rate_limit_event` brings other values: five_hour 8 %, seven_day 23 %.
 */
export class FakeUsage {
  private readonly windows = new Map<string, UsageWindow>();

  constructor(
    private readonly now: () => Date,
    private readonly options: FakeOverviewOptions,
  ) {}

  /** A played raw message: a `rate_limit_event` updates the windows it reports (fraction 0–1). */
  observe(raw: unknown): void {
    const parsed = rateLimitEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const info = parsed.data.rate_limit_info;
    const reset = (s: number | null | undefined): string | null =>
      typeof s === 'number' ? new Date(s * 1000).toISOString() : null;
    if (typeof info.rateLimitType === 'string' && typeof info.utilization === 'number') {
      this.windows.set(info.rateLimitType, { utilization: info.utilization, resetsAt: reset(info.resetsAt) });
    }
    for (const [name, window] of Object.entries(info.unifiedWindows ?? {})) {
      if (typeof window.utilization !== 'number') continue;
      this.windows.set(name, { utilization: window.utilization, resetsAt: reset(window.resetsAt) });
    }
  }

  /**
   * The raw answer of `usage_EXPERIMENTAL…()` (utilization 0–100, like the CLI) – null when the
   * fake lever says `unavailable`; throws for `failed`.
   */
  answer(): unknown {
    const mode = this.options.usage ?? 'ok';
    if (mode === 'unavailable') return null;
    if (mode === 'failed') throw new Error('usage request failed');
    if (mode === 'no-plan') return { subscription_type: null, rate_limits_available: false, rate_limits: null };
    const nowMs = this.now().getTime();
    const window = (name: string, fallback: UsageWindow): Record<string, unknown> => {
      const w = this.windows.get(name) ?? fallback;
      return { utilization: Math.round(w.utilization * 1000) / 10, resets_at: w.resetsAt };
    };
    return {
      session: { total_cost_usd: 0 },
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: window('five_hour', { utilization: 0.08, resetsAt: new Date(nowMs + 3 * HOUR_MS).toISOString() }),
        seven_day: window('seven_day', { utilization: 0.23, resetsAt: new Date(nowMs + 96 * HOUR_MS).toISOString() }),
        // Codename windows without a value (the CLI sends many of them) – ignored by the parser.
        seven_day_oauth_apps: null,
        seven_day_cowork: null,
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      },
    };
  }
}

// ---- titles ----

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

/**
 * `generateSessionTitle` of the fake CLI: with `persist` a title the session already has (custom
 * or AI) is answered without a new one (like the CLI), else `Fake: <first words>` is written as its
 * AI title; without `persist` `Fake (new): <first words>`. The words come from the first non-empty
 * line of the description.
 */
export function fakeTitle(
  history: FakeHistoryStore,
  sessionId: string | null,
  description: string,
  persist: boolean,
): TitleResult {
  if (persist && sessionId !== null) {
    const existing = history.title(sessionId);
    if (existing !== null) return { ok: true, title: existing };
  }
  const words = firstWords(firstLine(description));
  if (words === '') return { ok: true, title: null };
  const title = persist ? `Fake: ${words}` : `Fake (new): ${words}`;
  if (persist && sessionId !== null) history.setAiTitle(sessionId, title);
  return { ok: true, title };
}

// ---- fake:long-bash ----

/** `fake:long-bash`: the foreground command runs this long (× speed; forever at speed 0). */
export const FAKE_LONG_BASH_MS = 60_000;
/** Moved to the background, it ends this long later (× speed, not capped). */
export const FAKE_LONG_BASH_BACKGROUND_MS = 20_000;
export const FAKE_LONG_BASH_INPUT = { command: 'pnpm test --watch', description: 'Run the test suite' } as const;
export const FAKE_LONG_BASH_DONE = 'The test run finished: 12 tests passed.';
export const FAKE_LONG_BASH_MOVED = 'The test run continues in the background; I will report when it is done.';
export const FAKE_LONG_BASH_REPORT = 'Background test run finished: 12 tests passed.';

function toolProgress(c: DslContext, toolUseId: string, seconds: number): FixtureEvent[] {
  return toEvents([
    frame(
      c,
      msg({
        type: 'tool_progress',
        tool_use_id: toolUseId,
        tool_name: 'Bash',
        parent_tool_use_id: null,
        elapsed_time_seconds: seconds,
      }),
    ),
  ]);
}

/** Raw messages of DSL events (all `message` kind). */
function messagesOf(list: readonly FixtureEvent[]): unknown[] {
  return list.flatMap((event) => (event.kind === 'message' ? [event.payload] : []));
}

export async function longBash(ctx: FakeScriptContext, c: DslContext, turn: Turn, sessionId: string): Promise<void> {
  const toolUseId = ctx.ids.toolUseId();
  const input = { ...FAKE_LONG_BASH_INPUT };
  turn.toolUseId = toolUseId;
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      toolUseBlock(c, 'Bash', input, { toolUseId, thinking: 'I will run the test suite.' }),
      toolProgress(c, toolUseId, 1),
    ),
  );
  const outcome = await ctx.foregroundTool(toolUseId, FAKE_LONG_BASH_MS);
  turn.toolUseId = null;
  if (outcome === 'done') {
    await ctx.play(
      events(
        toolResultMessage(c, toolUseId, '12 passed', {
          toolUseResult: { stdout: '12 passed', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
        }),
        streamedText(c, FAKE_LONG_BASH_DONE),
        turnClose(c, turn.prompt, { result: { result: FAKE_LONG_BASH_DONE } }),
      ),
    );
    return;
  }
  // Like Ctrl+B in the terminal: the call ends with a background task id, the turn goes on.
  const taskId = `b${toolUseId.replace(/[^a-z0-9]/gi, '').slice(-8)}`;
  const notification = (status: 'completed' | 'stopped', summary: string): FixtureEvent[] =>
    toEvents([
      frame(
        c,
        system(0, 'task_notification', {
          task_id: taskId,
          tool_use_id: toolUseId,
          status,
          output_file: '',
          summary,
        }),
      ),
    ]);
  await ctx.play(
    events(
      toEvents([
        frame(
          c,
          system(0, 'task_started', {
            task_id: taskId,
            tool_use_id: toolUseId,
            description: input.description,
            task_type: 'local_bash',
            is_backgrounded: true,
          }),
        ),
      ]),
      toolResultMessage(c, toolUseId, `Command was manually backgrounded by user with ID: ${taskId}`, {
        toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: taskId },
      }),
      streamedText(c, FAKE_LONG_BASH_MOVED),
      turnClose(c, turn.prompt, { result: { result: FAKE_LONG_BASH_MOVED } }),
    ),
  );
  ctx.startTask({
    taskId,
    run: async (control) => {
      await control.wait(FAKE_LONG_BASH_BACKGROUND_MS);
      control.emit(messagesOf(notification('completed', `${input.description} finished`)));
      control.finish('completed');
      const now = contextFor(ctx, sessionId);
      await control.betweenTurns(
        events(
          turnOpen(now, null),
          streamedText(now, FAKE_LONG_BASH_REPORT),
          turnClose(now, null, { result: { result: FAKE_LONG_BASH_REPORT } }),
        ),
      );
    },
    stopped: () => messagesOf(notification('stopped', `${input.description} was stopped`)),
  });
}

// ---- fake:summary ----

export const FAKE_SUMMARY_SENTENCES = ['Reading the project notes', 'Writing the summary'] as const;
export const FAKE_SUMMARY_ANSWER = '**Summary:** the fake project has three files and no open problems.\n\nDetails follow.';
export const FAKE_SUMMARY_DETAIL = 'Summarized the fake project: three files, no open problems.';
/** Pause between the steps (× speed, ≤ maxDelayMs) – long enough to see the live sentence. */
export const FAKE_SUMMARY_STEP_MS = 2_500;

const assistantUuidSchema = z.looseObject({
  type: z.literal('assistant'),
  uuid: z.string(),
  parent_tool_use_id: z.string().nullable().optional(),
});

/** uuid of the last main-thread assistant message among `list`. */
function lastAssistantUuid(list: readonly FixtureEvent[]): string | null {
  let found: string | null = null;
  for (const event of list) {
    if (event.kind !== 'message') continue;
    const parsed = assistantUuidSchema.safeParse(event.payload);
    if (parsed.success && (parsed.data.parent_tool_use_id ?? null) === null) found = parsed.data.uuid;
  }
  return found;
}

/**
 * `fake:summary`: a Read, then the answer. With the fake bridge connected the CLI's live sentence
 * (`task_summary`) comes before each step and the turn summary (`post_turn_summary`) right before
 * the result; without a bridge neither comes (the engine's fallback shows).
 */
export async function summaryTurn(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const bridged = (): boolean => ctx.remoteControl !== null;
  const sentence = (detail: string | null): FixtureEvent[] =>
    bridged() ? toEvents([frame(c, system(0, 'task_summary', { detail }))]) : [];
  const toolUseId = ctx.ids.toolUseId();
  const filePath = `${ctx.req.cwd}\\notes.md`;
  await ctx.play(events(turnOpen(c, turn.prompt), sentence(FAKE_SUMMARY_SENTENCES[0])));
  await ctx.play(toolUseBlock(c, 'Read', { file_path: filePath }, { toolUseId }));
  await ctx.pause(FAKE_SUMMARY_STEP_MS);
  await ctx.play(
    events(
      toolResultMessage(c, toolUseId, '1\tThree files, no open problems.', {
        toolUseResult: { type: 'text', file: { filePath, content: 'Three files, no open problems.', numLines: 1, startLine: 1, totalLines: 1 } },
      }),
      sentence(FAKE_SUMMARY_SENTENCES[1]),
    ),
  );
  await ctx.pause(FAKE_SUMMARY_STEP_MS);
  const answer = streamedText(c, FAKE_SUMMARY_ANSWER);
  const uuid = lastAssistantUuid(answer);
  await ctx.play(
    events(
      answer,
      bridged() && uuid !== null
        ? toEvents([
            frame(
              c,
              system(0, 'post_turn_summary', {
                summarizes_uuid: uuid,
                status_category: 'completed',
                status_detail: FAKE_SUMMARY_DETAIL,
                needs_action: '',
              }),
            ),
          ])
        : [],
      sentence(null),
      turnClose(c, turn.prompt, { result: { result: FAKE_SUMMARY_ANSWER } }),
    ),
  );
}
