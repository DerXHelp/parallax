/**
 * WP-95: `fake:cli-notices` – the internal system messages of CLI 2.1.323 that Parallax shows
 * (docs/wp/WP-95.md §1): a Bash call that waits on its automatic permission check
 * (`permission_check_status` checking → done), the repository change of that commit
 * (`vcs_state_changed`), a model fallback, files of a message that did not arrive
 * (`file_attachments_missing`) and a held peer message that is dropped (`peer_message_hold`).
 */
import { system } from '../../sessions/normalizer/synthetic/build';
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
import type { Turn } from './turn';
import type { FakeScriptContext } from './types';

/** How long the fake permission check keeps the call waiting (× speed, ≤ maxDelayMs). */
export const FAKE_PERMISSION_CHECK_MS = 3_000;
export const FAKE_CLI_NOTICES_COMMAND = 'git commit -m "Fake commit"';
export const FAKE_CLI_NOTICES_ANSWER = 'Committed. Opus was busy, so Sonnet finished the turn.';
export const FAKE_FALLBACK = { from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' } as const;
export const FAKE_PEER = { from: 'session_fake_peer', name: 'Fake peer' } as const;

export async function cliNotices(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const toolUseId = ctx.ids.toolUseId();
  const peerUuid = ctx.ids.uuid();
  const check = (status: 'checking' | 'done') =>
    toEvents([frame(c, system(0, 'permission_check_status', { tool_use_id: toolUseId, status }))]);
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      toolUseBlock(c, 'Bash', { command: FAKE_CLI_NOTICES_COMMAND, description: 'Commit the change' }, { toolUseId }),
      check('checking'),
    ),
  );
  await ctx.pause(FAKE_PERMISSION_CHECK_MS);
  await ctx.play(
    events(
      check('done'),
      toolResultMessage(c, toolUseId, '[main 1a2b3c4] Fake commit\n 1 file changed, 1 insertion(+)'),
      toEvents([
        frame(c, system(0, 'vcs_state_changed', { kind: 'commit', branch: 'main', cwd: ctx.req.cwd })),
        frame(
          c,
          system(0, 'model_fallback', {
            trigger: 'overloaded',
            original_model: FAKE_FALLBACK.from,
            fallback_model: FAKE_FALLBACK.to,
            content: `${FAKE_FALLBACK.from} is overloaded – switched to ${FAKE_FALLBACK.to} for this turn.`,
          }),
        ),
        frame(
          c,
          system(0, 'file_attachments_missing', {
            message_uuid: turn.prompt,
            sent_count: 2,
            missing: [{ file_uuid: ctx.ids.uuid(), reason: 'download_failed' }],
          }),
        ),
        frame(
          c,
          system(0, 'peer_message_hold', {
            state: 'held',
            message_uuid: peerUuid,
            lane: 'socket',
            from: FAKE_PEER.from,
            from_name: FAKE_PEER.name,
            cause: 'explicit-setting',
          }),
        ),
        frame(
          c,
          system(0, 'peer_message_hold', {
            state: 'dropped',
            message_uuid: peerUuid,
            lane: 'socket',
            from: FAKE_PEER.from,
            outcome: 'expired',
          }),
        ),
      ]),
      streamedText(c, FAKE_CLI_NOTICES_ANSWER),
      turnClose(c, turn.prompt, { result: { result: FAKE_CLI_NOTICES_ANSWER } }),
    ),
  );
}
