/**
 * subagent – Agent tool with a mini task (point 11): parent_tool_use_id, task_* events,
 * background launch (async_launched) and task_notification, when the work is really finished.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { isResult } from '../messages';
import { allowOnce, FatalError } from '../session';
import { withSession, type Scenario } from './common';

const DESCRIPTION =
  'Agent tool (general-purpose, haiku) answering PONG without tools; parent_tool_use_id, task_started/' +
  'task_progress/task_notification, background_tasks_changed, result vs. idle timing.';

export const subagent: Scenario = {
  name: 'subagent',
  description: DESCRIPTION,
  live: true,
  async run(ctx) {
    await withSession(
      ctx,
      'subagent',
      DESCRIPTION,
      { permissionMode: 'default', maxTurns: 6, policy: (_tool, input) => allowOnce(input) },
      async (session, rec) => {
        const from = session.messages.length;
        session.send(
          'Use the Agent tool exactly once with subagent_type "general-purpose", model "haiku", ' +
            'description "Spike ping" and prompt "Reply with exactly the word PONG. Do not use any tools." ' +
            'Wait for its result, then reply with exactly: SUBAGENT SAID <its answer>',
        );
        let results = 0;
        let next = from;
        // The main turn may end before a background agent finishes; its notification starts a new turn.
        for (;;) {
          const result = await session.waitFor((message) => isResult(message), {
            from: next,
            label: `result #${results + 1}`,
            timeoutMs: 240_000,
          });
          next = session.messages.indexOf(result) + 1;
          results += 1;
          const text = isResult(result) && result.subtype === 'success' ? result.result : '';
          rec.mark('result-seen', { n: results, text });
          if (text.includes('PONG') || results >= 3) break;
        }
        await session.waitIdle(from, 30_000);
        await sleep(3_000);
        await session.call('getContextUsage', [{ detail: 'summary' }], (q) =>
          q.getContextUsage({ detail: 'summary' }),
        );
        if (session.fatal !== undefined) throw new FatalError(session.fatal.kind, session.fatal.message);
      },
    );
  },
};
