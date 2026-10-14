/**
 * resume – continue the auth-probe session by id with the last actual permission mode (point 14),
 * one mini prompt; promptSuggestions on (a resumed session is not on its first turn).
 */
import { describeError, FatalError } from '../session';
import { withSession, type Scenario } from './common';

const DESCRIPTION =
  'resume of the auth-probe session (same cwd) with permissionMode default and promptSuggestions; ' +
  'session id after resume, cumulative cost, prompt_suggestion after result.';

export const resume: Scenario = {
  name: 'resume',
  description: DESCRIPTION,
  live: true,
  async run(ctx) {
    const probe = [...ctx.state.sessions]
      .reverse()
      .find((record) => record.scenario === 'auth-probe' && record.ok);
    const resumeId = probe?.sessionIds[0];
    if (probe === undefined || resumeId === undefined)
      throw new Error('no successful auth-probe session to resume');
    await withSession(
      ctx,
      'resume',
      DESCRIPTION,
      {
        cwd: probe.cwd,
        resume: resumeId,
        permissionMode: 'default',
        promptSuggestions: true,
        maxTurns: 2,
        baseline: probe,
      },
      async (session, rec) => {
        const turn = await session.turn('Reply with exactly: RESUMED');
        rec.mark('resume-ids', {
          resumed: resumeId,
          initSessionId: session.sessionId ?? null,
          sameId: session.sessionId === resumeId,
          firstResultCost: session.usage.firstCost ?? null,
          baselineCost: probe.costUsd,
        });
        try {
          await session.waitFor((message) => message.type === 'prompt_suggestion', {
            from: turn.from,
            label: 'prompt_suggestion',
            timeoutMs: 25_000,
          });
        } catch (error) {
          if (error instanceof FatalError) throw error;
          rec.mark('no-prompt-suggestion', { error: describeError(error).message });
        }
      },
    );
  },
};
