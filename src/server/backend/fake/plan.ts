/**
 * `fake:plan` and the fresh-context start of the interactive fake scenario (Phase 3, WP-52).
 * Plan mode like the CLI: the mode switches to `plan` (system/status, as after EnterPlanMode),
 * the plan file is written with `Write` – input streamed in ≥ 5 `input_json_delta` parts – as a
 * REAL file under `<filesRoot>\<sessionId>\plans\fake-plan.md`, then `ExitPlanMode` with
 * `planFilePath`. Feedback (deny) → v2 with changed text into the same file; approve → mode,
 * IMPLEMENTED (the `hello.txt` of the implementation stays transcript-only, never in the project).
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { parsePermissionMode } from '@shared/common';
import { system as systemFrame } from '../../sessions/normalizer/synthetic/build';
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
import { patchHunks } from './files';
import { CANCEL_DENY, abortedByDecision, answerTurn, ask, firstWords, type Turn } from './turn';
import type { FakeScriptContext } from './types';

/** Plan file of `fake:plan`, relative to the session's fake folder. */
export const FAKE_PLAN_FILE = 'plans\\fake-plan.md';
/** `input_json_delta` parts of the plan file's Write (WP-52: ≥ 5). */
export const FAKE_PLAN_INPUT_CHUNKS = 8;
/** First words of the engine's fresh-context prompt (ADR-147, WP-51). */
export const IMPLEMENT_PLAN_PREFIX = 'Implement the following approved plan.';
const PLAN_FILE_PREFIX = 'Plan file:';

const PLAN_V1 = '## Plan\n- Create `hello.txt` with the content `hello`.\n- Reply with exactly: IMPLEMENTED\n';
const WRITE_NOTE = ' (file state is current in your context — no need to Read it back)';

function setModeOf(result: PermissionResult): string | null {
  if (result.behavior !== 'allow') return null;
  const setMode = (result.updatedPermissions ?? []).find((u) => u.type === 'setMode');
  return setMode?.type === 'setMode' ? setMode.mode : null;
}

/** The plan file's Write: streamed input, the real file, the CLI's create/update result. */
async function writePlanFile(ctx: FakeScriptContext, c: DslContext, text: string): Promise<string> {
  const planFilePath = ctx.files.path(FAKE_PLAN_FILE);
  const original = (await ctx.files.exists(FAKE_PLAN_FILE)) ? await ctx.files.read(FAKE_PLAN_FILE) : null;
  const writeId = ctx.ids.toolUseId();
  await ctx.play(
    toolUseBlock(
      c,
      'Write',
      { file_path: planFilePath, content: text },
      { toolUseId: writeId, thinking: 'Writing the plan.', inputChunks: FAKE_PLAN_INPUT_CHUNKS },
    ),
  );
  // Plan mode: the plan file is written without a permission card (F.6) – before the result.
  await ctx.files.write(FAKE_PLAN_FILE, text);
  const created = original === null;
  await ctx.play(
    toolResultMessage(
      c,
      writeId,
      created
        ? `File created successfully at: ${planFilePath}${WRITE_NOTE}`
        : `The file ${planFilePath} has been updated successfully.${WRITE_NOTE}`,
      {
        toolUseResult: {
          type: created ? 'create' : 'update',
          filePath: planFilePath,
          content: text,
          structuredPatch: created ? [] : patchHunks(original, text),
          originalFile: original,
          userModified: false,
        },
      },
    ),
  );
  return planFilePath;
}

export async function plan(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  let text = PLAN_V1;
  await ctx.play(turnOpen(c, turn.prompt));
  if (ctx.state.permissionMode !== 'plan') {
    // Like EnterPlanMode: the CLI reports the new mode in the turn (F.2).
    ctx.state.permissionMode = 'plan';
    await ctx.play(toEvents([frame(c, systemFrame(0, 'status', { status: null, permissionMode: 'plan' }))]));
  }
  for (let version = 1; version <= 5; version += 1) {
    const planFilePath = await writePlanFile(ctx, c, text);
    const exitId = ctx.ids.toolUseId();
    const input = { plan: text, planFilePath };
    await ctx.play(toolUseBlock(c, 'ExitPlanMode', input, { toolUseId: exitId }));
    const result = await ask(ctx, c, turn, 'ExitPlanMode', input, exitId, { requiresUserInteraction: true });
    if (CANCEL_DENY(result)) return abortedByDecision(ctx, c, turn);
    if (result.behavior === 'deny') {
      // Revise (F.6): the feedback goes back to Claude, a new version follows.
      await ctx.play(
        toolResultMessage(c, exitId, result.message, {
          isError: true,
          toolUseResult: `Error: ${result.message}`,
        }),
      );
      text = `${text}- Revision ${String(version)}: ${firstWords(result.message, 12)}\n`;
      continue;
    }
    const mode = parsePermissionMode(setModeOf(result)) ?? 'default';
    ctx.state.permissionMode = mode;
    const approved = typeof result.updatedInput?.plan === 'string' ? result.updatedInput.plan : text;
    const implementId = ctx.ids.toolUseId();
    turn.toolUseId = null;
    await ctx.play(
      events(
        toEvents([frame(c, systemFrame(0, 'status', { status: null, permissionMode: mode }))]),
        toolResultMessage(
          c,
          exitId,
          `User has approved your plan. You can now start coding.\n\nYour plan has been saved to: ${planFilePath}\n\n## Approved Plan:\n${approved}`,
          {
            toolUseResult: {
              plan: approved,
              isAgent: false,
              filePath: planFilePath,
              planWasEdited: approved !== text,
            },
          },
        ),
        toolUseBlock(
          c,
          'Write',
          { file_path: `${ctx.req.cwd}\\hello.txt`, content: 'hello' },
          { toolUseId: implementId },
        ),
        toolResultMessage(c, implementId, `File created successfully at: ${ctx.req.cwd}\\hello.txt`),
        streamedText(c, 'IMPLEMENTED'),
        turnClose(c, turn.prompt, { result: { result: 'IMPLEMENTED' } }),
      ),
    );
    return;
  }
  await ctx.play(events(streamedText(c, 'Giving up after five plan revisions.'), turnClose(c, turn.prompt)));
}

/**
 * Lines of the plan in a fresh-context prompt: the non-empty lines after the first blank line
 * (`Implement the following approved plan.` + optional `Plan file: …` + blank line + plan text).
 */
export function implementPlanLines(text: string): number {
  const blank = /\r?\n[ \t]*\r?\n/.exec(text);
  const body = blank === null ? '' : text.slice(blank.index + blank[0].length);
  const lines = body.split(/\r?\n/).filter((line) => line.trim() !== '');
  // Tolerant: a `Plan file:` line after the blank line is no plan line either.
  return lines[0]?.startsWith(PLAN_FILE_PREFIX) === true ? lines.length - 1 : lines.length;
}

/** The first prompt of a start without resume is the engine's fresh-context prompt (ADR-147). */
export function isImplementPlanPrompt(ctx: FakeScriptContext, text: string): boolean {
  return ctx.req.resumeSessionId === null && ctx.state.turns === 0 && text.startsWith(IMPLEMENT_PLAN_PREFIX);
}

export function implementPlanText(text: string): string {
  return `Fake: implementing plan (${String(implementPlanLines(text))} lines)`;
}

export async function implementPlan(ctx: FakeScriptContext, c: DslContext, turn: Turn, text: string): Promise<void> {
  await answerTurn(ctx, c, turn, implementPlanText(text));
}
