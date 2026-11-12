/**
 * Fake scenarios for the user feedback round WP-63 (compact transcript, limit warnings), answered
 * by the interactive scenario (interactive.ts):
 * - `fake:steps` – a long run of work steps as in real sessions: thinking + Bash, one failing
 *   command, an intermediate sentence to the user, then more steps and the answer (§1.5 groups);
 * - `fake:images` – a burst of `Read` results with a PNG each, then the answer (§1.5 gallery);
 * - `fake:limit-warning` – `allowed_warning` for the weekly window: only the limit bar changes,
 *   the transcript gets no notice (§1.2).
 */
import { msg } from '../../sessions/normalizer/synthetic/build';
import type { FixtureEvent } from '../fixture';
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
import { FAKE_SHOT_HEIGHT, FAKE_SHOT_PNG_BASE64, FAKE_SHOT_WIDTH } from './image';
import type { Turn } from './turn';
import type { FakeScriptContext } from './types';

/** `fake:steps`: commands of the first and the second run; the failing one is marked. */
export const FAKE_STEP_COMMANDS: readonly { command: string; fails?: true }[] = [
  { command: 'pnpm install --frozen-lockfile' },
  { command: 'pnpm typecheck' },
  { command: 'pnpm lint' },
  { command: 'pnpm test --run src/a.test.ts', fails: true },
  { command: 'pnpm test --run src/a.test.ts' },
  { command: 'pnpm build' },
];
/** `fake:steps`: the sentence between the two runs (ends the first group). */
export const FAKE_STEPS_MIDDLE = 'Halfway there: the build is green, now the second round.';
export const FAKE_STEPS_ANSWER = 'All steps are done; one test failed once and passed on the retry.';
/** `fake:images`: this many screenshots in one burst. */
export const FAKE_IMAGE_BURST = 4;
export const FAKE_IMAGES_ANSWER = 'The four screenshots show the same window in four sizes.';
export const FAKE_LIMIT_WARNING_ANSWER = 'The weekly limit is at 81 %.';

function bashStep(c: DslContext, toolUseId: string, step: { command: string; fails?: true }): FixtureEvent[] {
  const output = step.fails === true ? 'FAIL src/a.test.ts (1 failed)' : `ok: ${step.command}`;
  return events(
    toolUseBlock(
      c,
      'Bash',
      { command: step.command, description: step.command },
      {
        toolUseId,
        thinking: `Next: ${step.command}.`,
        chunks: 2,
      },
    ),
    toolResultMessage(c, toolUseId, output, {
      isError: step.fails === true,
      toolUseResult:
        step.fails === true
          ? `Error: ${output}`
          : { stdout: output, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
    }),
  );
}

/** `fake:steps`: two runs of Bash steps with thinking, separated by one sentence to the user. */
export async function steps(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  await ctx.play(turnOpen(c, turn.prompt));
  for (const step of FAKE_STEP_COMMANDS) await ctx.play(bashStep(c, ctx.ids.toolUseId(), step));
  await ctx.play(streamedText(c, FAKE_STEPS_MIDDLE, { chunks: 3 }));
  for (const step of FAKE_STEP_COMMANDS.filter((candidate) => candidate.fails !== true).slice(0, 3)) {
    await ctx.play(bashStep(c, ctx.ids.toolUseId(), step));
  }
  await ctx.play(
    events(
      streamedText(c, FAKE_STEPS_ANSWER, { chunks: 3 }),
      turnClose(c, turn.prompt, { result: { result: FAKE_STEPS_ANSWER } }),
    ),
  );
}

/** `fake:images`: a burst of Read results with one PNG each (stored as blobs, ADR-103). */
export async function images(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  await ctx.play(turnOpen(c, turn.prompt));
  for (let n = 1; n <= FAKE_IMAGE_BURST; n++) {
    const toolUseId = ctx.ids.toolUseId();
    const filePath = `${ctx.req.cwd}\\shots\\shot-${String(n)}.png`;
    await ctx.play(
      events(
        toolUseBlock(c, 'Read', { file_path: filePath }, { toolUseId, chunks: 2 }),
        toolResultMessage(
          c,
          toolUseId,
          [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: FAKE_SHOT_PNG_BASE64 },
            },
          ],
          {
            toolUseResult: {
              type: 'image',
              file: {
                type: 'image/png',
                originalSize: Buffer.from(FAKE_SHOT_PNG_BASE64, 'base64').byteLength,
                dimensions: { originalWidth: FAKE_SHOT_WIDTH, originalHeight: FAKE_SHOT_HEIGHT },
              },
            },
          },
        ),
      ),
    );
  }
  await ctx.play(
    events(
      streamedText(c, FAKE_IMAGES_ANSWER, { chunks: 3 }),
      turnClose(c, turn.prompt, { result: { result: FAKE_IMAGES_ANSWER } }),
    ),
  );
}

/** `fake:limit-warning`: the weekly window at 81 % (`allowed_warning`) – the bar only. */
export async function limitWarning(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const nowS = Math.floor(ctx.now().getTime() / 1000);
  const fiveHourReset = nowS + 3 * 3600;
  const weeklyReset = nowS + 3 * 86_400;
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      toEvents([
        frame(
          c,
          msg({
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'allowed_warning',
              resetsAt: weeklyReset,
              rateLimitType: 'seven_day',
              utilization: 0.81,
              unifiedWindows: {
                five_hour: { utilization: 0.12, resetsAt: fiveHourReset },
                seven_day: { utilization: 0.81, resetsAt: weeklyReset },
              },
            },
          }),
        ),
      ]),
      streamedText(c, FAKE_LIMIT_WARNING_ANSWER),
      turnClose(c, turn.prompt, { result: { result: FAKE_LIMIT_WARNING_ANSWER } }),
    ),
  );
}
