/**
 * queue-priority – streaming-input queue during a running turn (point 9).
 * extraArgs {'replay-user-messages': null} (compare with the other fixtures, which run without it).
 *  A: Bash `sleep 4` turn; while the tool runs, B is pushed with priority 'next'.
 *  C: Bash `sleep 8` turn; while the tool runs, D is pushed with priority 'now'.
 * Records which results/assistant frames list the uuids in user_message_uuids.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { hasToolUse, isResult, resultUuids } from '../messages';
import { allowOnce, deny, type LiveSession } from '../session';
import { withSession, type Scenario } from './common';

const DESCRIPTION =
  'replay-user-messages on; message B (priority next) pushed during a Bash tool call of turn A; ' +
  'message D (priority now) pushed during a Bash tool call of turn C; user_message_uuids, replays.';

function consumed(session: LiveSession, from: number): Set<string> {
  return new Set(session.messages.slice(from).filter(isResult).flatMap(resultUuids));
}

async function waitConsumed(
  session: LiveSession,
  from: number,
  uuids: readonly string[],
  label: string,
): Promise<void> {
  await session.waitFor(
    (message: SDKMessage) => isResult(message) && uuids.every((uuid) => consumed(session, from).has(uuid)),
    { from, label, timeoutMs: 180_000 },
  );
}

export const queuePriority: Scenario = {
  name: 'queue-priority',
  description: DESCRIPTION,
  live: true,
  async run(ctx) {
    await withSession(
      ctx,
      'queue-priority',
      DESCRIPTION,
      {
        permissionMode: 'default',
        maxTurns: 6,
        extraArgs: { 'replay-user-messages': null },
        policy: (tool, input) => (tool === 'Bash' ? allowOnce(input) : deny('Not needed.')),
      },
      async (session, rec) => {
        const fromA = session.messages.length;
        const a = session.send('Use the Bash tool to run: sleep 4   Then reply with exactly: FIRST');
        await session.waitFor((message) => hasToolUse(message, 'Bash'), {
          from: fromA,
          label: 'Bash tool_use (A)',
        });
        const b = session.send('Additionally reply with the word: NEXT', { priority: 'next' });
        rec.mark('pushed-next', { a, b });
        await waitConsumed(session, fromA, [a, b], 'results for A and B');
        await session.waitIdle(session.messages.length - 1, 20_000);

        const fromC = session.messages.length;
        const c = session.send('Use the Bash tool to run: sleep 8   Then reply with exactly: THIRD');
        await session.waitFor((message) => hasToolUse(message, 'Bash'), {
          from: fromC,
          label: 'Bash tool_use (C)',
        });
        await sleep(1_000);
        const d = session.send('Reply with exactly: NOW', { priority: 'now' });
        rec.mark('pushed-now', { c, d });
        await waitConsumed(session, fromC, [d], 'result for D');
        // C may still produce its own result after D; give it time to settle.
        await sleep(3_000);
        await session.waitIdle(session.messages.length - 1, 30_000);
        rec.mark('consumed', {
          afterA: [...consumed(session, fromA)],
          afterC: [...consumed(session, fromC)],
        });
      },
    );
  },
};
