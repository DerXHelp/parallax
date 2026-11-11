/**
 * Building blocks of the interactive fake scenario's turns (WP-13 §3.3; split out of
 * `interactive.ts` in WP-52 for the Phase-3 scenario files): the turn record, the DSL context of
 * a script, canUseTool like the CLI and the plain answer turn.
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { system as systemFrame } from '../../sessions/normalizer/synthetic/build';
import { dslContext, events, frame, interruptEpilogue, streamedText, toEvents, turnClose, turnOpen, type DslContext } from './dsl';
import type { FakeScriptContext } from './types';

/** Per turn: what an interrupt epilogue needs. */
export interface Turn {
  prompt: string;
  toolUseId: string | null;
}

/** Thinking + answer stream of ~1 s at speed 1. */
export const ANSWER_STEP_MS = 40;

export function firstWords(text: string, count = 5): string {
  const words = text.trim().split(/\s+/).slice(0, count).join(' ');
  return words.length > 60 ? `${words.slice(0, 59)}…` : words;
}

export function contextFor(ctx: FakeScriptContext, sessionId: string): DslContext {
  return dslContext({
    sessionId,
    ids: ctx.ids,
    model: ctx.state.model,
    permissionMode: ctx.state.permissionMode,
    cwd: ctx.req.cwd,
    timestamp: () => ctx.now().toISOString(),
    stepMs: ANSWER_STEP_MS,
  });
}

export const CANCEL_DENY = (result: PermissionResult): boolean =>
  result.behavior === 'deny' && result.interrupt === true;

/** Asks canUseTool like the CLI (requires_action → gate → running). */
export async function ask(
  ctx: FakeScriptContext,
  c: DslContext,
  turn: Turn,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
  options: Record<string, unknown>,
): Promise<PermissionResult> {
  turn.toolUseId = toolUseId;
  await ctx.play(toEvents([frame(c, systemFrame(0, 'session_state_changed', { state: 'requires_action' }))]));
  const result = await ctx.canUseTool(toolName, input, {
    displayName: toolName,
    toolUseID: toolUseId,
    requestId: ctx.ids.uuid(),
    ...options,
  });
  if (!CANCEL_DENY(result)) {
    await ctx.play(toEvents([frame(c, systemFrame(0, 'session_state_changed', { state: 'running' }))]));
  }
  return result;
}

/** deny with interrupt: the CLI ends the turn as aborted (F.3, permissions#236). */
export async function abortedByDecision(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  await ctx.play(interruptEpilogue(c, { prompt: turn.prompt, toolUseId: turn.toolUseId }));
}

/** A turn that only answers with `text` (streamed). */
export async function answerTurn(ctx: FakeScriptContext, c: DslContext, turn: Turn, text: string): Promise<void> {
  await ctx.play(
    events(turnOpen(c, turn.prompt), streamedText(c, text), turnClose(c, turn.prompt, { result: { result: text } })),
  );
}
