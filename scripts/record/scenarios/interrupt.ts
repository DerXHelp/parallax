/**
 * interrupt – Query.interrupt() mid-turn (point 10).
 *  1. during a running Bash tool (node timer, 25 s – `sleep` is blocked by the CLI)
 *  2. follow-up turn (session state after the interrupt)
 *  3. during text streaming (count to 300)
 * Records the interrupt receipt, result subtype/terminal_reason and session_state_changed order.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { hasToolUse } from '../messages';
import { allowOnce, deny } from '../session';
import { withSession, type Scenario } from './common';

const DESCRIPTION =
  'interrupt() during a running Bash tool call (node timer 25 s), follow-up turn, interrupt() during text streaming; ' +
  'interrupt receipt, result subtype, terminal_reason, idle/result order.';

export const interrupt: Scenario = {
  name: 'interrupt',
  description: DESCRIPTION,
  live: true,
  async run(ctx) {
    await withSession(
      ctx,
      'interrupt',
      DESCRIPTION,
      {
        permissionMode: 'default',
        maxTurns: 4,
        policy: (tool, input) => (tool === 'Bash' ? allowOnce(input) : deny('Not needed.')),
      },
      async (session, rec) => {
        const from1 = session.messages.length;
        // The CLI blocks `sleep N` (also chained: "Blocked: sleep 25 followed by: …"); use a node timer.
        session.send(
          `Use the Bash tool to run exactly: node -e "setTimeout(() => console.log('finished'), 25000)"   ` +
            'Then reply with exactly: DONE',
        );
        await session.waitFor((message) => hasToolUse(message, 'Bash'), {
          from: from1,
          label: 'Bash tool_use',
        });
        await sleep(4_000);
        rec.mark('interrupt-during-tool');
        await session.control('interrupt', [], (q) => q.interrupt());
        await session.waitForResult(from1, 'result after interrupt (tool)', 60_000);
        await session.waitIdle(from1, 20_000);

        rec.mark('after-interrupt-turn');
        await session.turn('Reply with exactly: AFTER');

        const from3 = session.messages.length;
        session.send('Count from 1 to 300, one number per line, nothing else.');
        await session.waitFor(
          (message) =>
            message.type === 'stream_event' &&
            message.event.type === 'content_block_delta' &&
            message.event.delta.type === 'text_delta',
          { from: from3, label: 'first text_delta' },
        );
        await sleep(400);
        rec.mark('interrupt-during-stream');
        await session.control('interrupt', [], (q) => q.interrupt());
        await session.waitForResult(from3, 'result after interrupt (stream)', 60_000);
        await session.waitIdle(from3, 20_000);
      },
    );
  },
};
