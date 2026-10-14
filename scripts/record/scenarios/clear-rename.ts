/**
 * clear-rename – slash commands through a running SDK session (points 7, 8, 15 drive case).
 * The cwd starts with a lower-case drive letter (project-folder encoding test).
 * Turn "ONE" → `/rename Parallax Spike Title` → getSessionInfo/listSessions → `/clear` →
 * conversation_reset/new_conversation_id → turn "TWO" (which session_id do messages carry?) →
 * session info for old and new id, transcript entry types (titles) – no extra API calls.
 */
import { getSessionInfo, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe } from '../messages';
import { deny, describeError, FatalError, type LiveSession } from '../session';
import { summarizeTranscript } from '../transcripts';
import type { FixtureRecorder } from '../writer';
import { withSession, type Scenario } from './common';

const DESCRIPTION =
  'Lower-case drive cwd; turn ONE; /rename <name>; getSessionInfo; /clear → conversation_reset; ' +
  'turn TWO; session ids before/after; getSessionInfo/listSessions; transcript entry types (titles).';

export const RENAME_TITLE = 'Parallax Spike Title';

function swapDriveCase(cwd: string): string {
  const first = cwd.charAt(0);
  const swapped = first === first.toLowerCase() ? first.toUpperCase() : first.toLowerCase();
  return `${swapped}${cwd.slice(1)}`;
}

/** Sends a slash command and waits (tolerantly) for its result and idle. */
async function slash(session: LiveSession, rec: FixtureRecorder, command: string): Promise<number> {
  const from = session.messages.length;
  session.send(command);
  try {
    await session.waitForResult(from, `result of ${command}`, 60_000);
  } catch (error) {
    if (error instanceof FatalError) throw error;
    rec.mark('slash-no-result', { command, error: describeError(error).message });
  }
  await session.waitIdle(from, 10_000);
  rec.mark('slash-done', { command, messages: session.messages.slice(from).map(describe) });
  return from;
}

async function infoCalls(session: LiveSession, ids: readonly string[], cwd: string): Promise<void> {
  for (const id of ids) {
    await session.call('getSessionInfo', [id], () => getSessionInfo(id));
    await session.call('getSessionInfo', [id, { dir: cwd }], () => getSessionInfo(id, { dir: cwd }));
  }
  await session.call('listSessions', [{ dir: cwd }], () => listSessions({ dir: cwd }));
  const other = swapDriveCase(cwd);
  await session.call('listSessions', [{ dir: other }], () => listSessions({ dir: other }));
}

export const clearRename: Scenario = {
  name: 'clear-rename',
  description: DESCRIPTION,
  live: true,
  async run(ctx) {
    await withSession(
      ctx,
      'clear-rename',
      DESCRIPTION,
      { permissionMode: 'default', lowerDrive: true, maxTurns: 3, policy: () => deny('No tools needed.') },
      async (session, rec) => {
        const cwd = session.config.cwd;
        await session.turn('Reply with exactly: ONE');
        const firstId = session.sessionId;
        if (firstId === undefined) throw new Error('no session id after first turn');

        await slash(session, rec, `/rename ${RENAME_TITLE}`);
        await infoCalls(session, [firstId], cwd);

        const clearFrom = await slash(session, rec, '/clear');
        const reset = session.messages
          .slice(clearFrom)
          .find((message) => message.type === 'conversation_reset');
        const newId = reset?.type === 'conversation_reset' ? reset.new_conversation_id : undefined;
        rec.mark('after-clear', {
          firstId,
          newConversationId: newId ?? null,
          initSessionId: session.sessionId ?? null,
        });

        const two = await session.turn('Reply with exactly: TWO');
        const idsAfter = [
          ...new Set(session.messages.slice(two.from).map((message) => message.session_id ?? '')),
        ];
        rec.mark('session-ids-after-clear', { firstId, newConversationId: newId ?? null, idsAfter });

        await sleep(5_000);
        await infoCalls(session, newId === undefined ? [firstId] : [firstId, newId], cwd);
        for (const id of newId === undefined ? [firstId] : [firstId, newId]) {
          await session.call('transcript.summary', [id], () =>
            Promise.resolve(summarizeTranscript(id) ?? null),
          );
        }
      },
    );
  },
};
