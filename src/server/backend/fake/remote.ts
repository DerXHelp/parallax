/**
 * WP-64: Remote Control in the FakeBackend (docs/wp/WP-64.md §1.2). Shapes from the live spike of
 * 12.11.2026 (`.worktrees/_spike-rc`): `system/bridge_state` ready → connected, a prompt from the
 * Claude app as `command_lifecycle` with a foreign uuid plus a `user` replay with
 * `origin: {kind:'human'}`, an approval answered in the app as an aborted canUseTool after which the
 * tool runs. Interactive levers (only while the fake bridge is connected): `fake:remote-prompt [text]`,
 * `fake:remote-permission`, `fake:remote-fail`, `fake:remote-flaky`.
 */
import { makeError } from '@shared/errors';
import { msg, system as systemFrame } from '../../sessions/normalizer/synthetic/build';
import type { FixtureEvent } from '../fixture';
import type { RemoteControlInfo, RemoteControlResult } from '../types';
import {
  assistantMessage,
  events,
  frame,
  streamedText,
  textBlock,
  toEvents,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
  type DslContext,
} from './dsl';
import { CANCEL_DENY, abortedByDecision, answerTurn, type Turn } from './turn';
import type { FakeRemoteControlOptions, FakeScriptContext } from './types';

/** Bridge connect time of the spike (~300 ms between `ready` and `connected`). */
export const FAKE_REMOTE_CONNECT_MS = 300;
/** `fake:remote-permission`: the approval is answered in the "app" this long after it opened. */
export const FAKE_REMOTE_ANSWER_MS = 1_500;
/** `fake:remote-flaky`: the bridge reconnects after this long. */
export const FAKE_REMOTE_RECONNECT_MS = 1_000;
export const FAKE_REMOTE_OFF_TEXT = 'Remote Control is off – turn it on first (fake).';

const URL_BASE = 'https://claude.ai/code/session_';

/** `cse_fake<id>` ↔ `https://claude.ai/code/session_fake<id>` (like the CLI's cse_ / session_ pair). */
export function fakeBridgeInfo(bridgeSessionId: string): RemoteControlInfo {
  return { bridgeSessionId, sessionUrl: `${URL_BASE}${bridgeSessionId.replace(/^cse_/, '')}` };
}

export function newFakeBridgeId(uuid: string): string {
  return `cse_fake${uuid.replace(/-/g, '').slice(0, 20)}`;
}

/** Answer of a failing enable request per FakeRemoteControlOptions.enable. */
export function fakeEnableFailure(mode: FakeRemoteControlOptions['enable']): RemoteControlResult | null {
  switch (mode) {
    case 'unavailable':
      return { ok: false, error: makeError('REMOTE_CONTROL_UNAVAILABLE', { reason: 'sdk' }) };
    case 'auth':
      return { ok: false, error: makeError('REMOTE_CONTROL_AUTH') };
    case 'policy':
      return { ok: false, error: makeError('REMOTE_CONTROL_POLICY_DISABLED') };
    case 'failed':
      return {
        ok: false,
        error: makeError('REMOTE_CONTROL_FAILED', { reason: 'remote_control_terminal', detail: 'fake failure' }),
      };
    case 'ok':
    case undefined:
      return null;
  }
}

export function bridgeStateMessage(
  sessionId: string | null,
  uuid: string,
  state: string,
  fields: Record<string, unknown> = {},
): unknown {
  return {
    type: 'system',
    subtype: 'bridge_state',
    state,
    ...fields,
    uuid,
    ...(sessionId === null ? {} : { session_id: sessionId }),
  };
}

/** Echo of a prompt (`--replay-user-messages`): same uuid, origin human. */
function replayFrame(c: DslContext, uuid: string, text: string): FixtureEvent[] {
  return toEvents([
    frame(
      c,
      msg({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        isReplay: true,
        origin: { kind: 'human' },
        timestamp: c.timestamp(),
      }),
      { uuid },
    ),
  ]);
}

/** A whole turn of a prompt typed in the Claude app (foreign uuid; spike order: started, init, replay). */
export function remotePromptTurn(
  c: DslContext,
  o: { uuid: string; text: string; answer: string; totalCostUsd?: number },
): FixtureEvent[] {
  return events(
    turnOpen(c, o.uuid),
    replayFrame(c, o.uuid, o.text),
    assistantMessage(c, [textBlock(o.answer)], { chunks: 6 }),
    turnClose(c, o.uuid, {
      result: { result: o.answer, ...(o.totalCostUsd === undefined ? {} : { total_cost_usd: o.totalCostUsd }) },
    }),
  );
}

function remoteOff(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  return answerTurn(ctx, c, turn, FAKE_REMOTE_OFF_TEXT);
}

/**
 * `fake:remote-prompt [text]`: the local turn (with its own echo, which the normalizer drops), then a
 * turn of a prompt "from the Claude app". An interrupt during the remote part cancels the remote prompt.
 */
export async function remotePrompt(ctx: FakeScriptContext, c: DslContext, turn: Turn, text: string): Promise<void> {
  if (ctx.remoteControl === null) return remoteOff(ctx, c, turn);
  const local = 'A prompt from the Claude app follows (fake).';
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      replayFrame(c, turn.prompt, text),
      streamedText(c, local),
      turnClose(c, turn.prompt, { result: { result: local } }),
    ),
  );
  const remoteText = text.slice('fake:remote-prompt'.length).trim() || 'Hello from the phone';
  turn.prompt = ctx.ids.uuid();
  await ctx.play(remotePromptTurn(c, { uuid: turn.prompt, text: remoteText, answer: `From the app: ${remoteText}` }));
}

/**
 * `fake:remote-permission`: a Write approval that the "app" answers after FAKE_REMOTE_ANSWER_MS – the
 * CLI aborts canUseTool and the tool runs. Answered locally first, it behaves like `fake:edit`.
 */
export async function remotePermission(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  if (ctx.remoteControl === null) return remoteOff(ctx, c, turn);
  const toolUseId = ctx.ids.toolUseId();
  const input = { file_path: `${ctx.req.cwd}\\handy.txt`, content: 'hallo\n' };
  await ctx.play(events(turnOpen(c, turn.prompt), toolUseBlock(c, 'Write', input, { toolUseId })));
  turn.toolUseId = toolUseId;
  await ctx.play(toEvents([frame(c, systemFrame(0, 'session_state_changed', { state: 'requires_action' }))]));
  const decision = ctx.canUseTool('Write', input, {
    displayName: 'Write',
    toolUseID: toolUseId,
    requestId: ctx.ids.uuid(),
    description: 'handy.txt',
  });
  const app = ctx.pause(FAKE_REMOTE_ANSWER_MS).then(() => ctx.abortDecision(toolUseId));
  const result = await decision;
  const answeredInApp = await app;
  if (!answeredInApp && CANCEL_DENY(result)) return abortedByDecision(ctx, c, turn);
  const ok = answeredInApp || result.behavior === 'allow';
  const answer = answeredInApp
    ? 'handy.txt was written (approved in the Claude app).'
    : ok
      ? 'handy.txt was written.'
      : 'Okay, I left handy.txt alone.';
  turn.toolUseId = null;
  await ctx.play(
    events(
      toEvents([frame(c, systemFrame(0, 'session_state_changed', { state: 'running' }))]),
      ok
        ? toolResultMessage(c, toolUseId, `File created successfully at: ${input.file_path}`, {
            toolUseResult: { type: 'create', filePath: input.file_path, content: input.content, structuredPatch: [] },
          })
        : toolResultMessage(c, toolUseId, 'The user denied this.', { isError: true }),
      streamedText(c, answer),
      turnClose(c, turn.prompt, { result: { result: answer } }),
    ),
  );
}

/** `fake:remote-fail`: the bridge fails for good (terminal) – Remote Control is off afterwards. */
export async function remoteFail(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  if (ctx.remoteControl === null) return remoteOff(ctx, c, turn);
  ctx.bridgeState('failed', { detail: 'Remote Control session ended (fake)', failure_kind: 'terminal' });
  await answerTurn(ctx, c, turn, 'The Remote Control connection failed (fake).');
}

/** `fake:remote-flaky`: a retrying failure, then `connected` with `recovered` after FAKE_REMOTE_RECONNECT_MS. */
export async function remoteFlaky(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  if (ctx.remoteControl === null) return remoteOff(ctx, c, turn);
  ctx.bridgeState('failed', { detail: 'network down (fake)', failure_kind: 'transient' });
  await answerTurn(ctx, c, turn, 'The Remote Control connection drops for a moment (fake).');
  await ctx.pause(FAKE_REMOTE_RECONNECT_MS);
  ctx.bridgeState('connected', { recovered: true, bridge_epoch: 2 });
}
