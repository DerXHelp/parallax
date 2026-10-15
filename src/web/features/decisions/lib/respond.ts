import { parseSessionKey, type DecisionId } from '@shared/common';
import type { Decision, DecisionResponse } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { markLocalResolution, unmarkLocalResolution } from '../state/bar-store';

/**
 * Commands of the decision feature. The client sends only INTENTS (ADR-012, C.4): remember
 * destination, accept-edits flag, plan mode – the server builds `updatedPermissions`/`setMode`
 * from the stored suggestions. Failures become a local notice (architecture §2.3i); answering a
 * decision that another window answered first is `DECISION_ALREADY_RESOLVED` (first click wins).
 */

/** Sends the answer; resolves `true` once the server accepted it (the card then disappears). */
export async function respondToDecision(
  sessionKey: string,
  decision: Decision,
  response: DecisionResponse,
): Promise<boolean> {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return false;
  markLocalResolution([decision.id]);
  try {
    await sendCommand(sessionKey, {
      name: 'decision.respond',
      entryId: parsed.entryId,
      decisionId: decision.id,
      response,
    });
    return true;
  } catch (caught) {
    const error = errorPayloadOf(caught);
    const alreadyResolved = error.code === 'DECISION_ALREADY_RESOLVED';
    if (!alreadyResolved) unmarkLocalResolution(decision.id);
    showErrorNotice(error, {
      sessionKey,
      id: `decisions.respond.${decision.id}`,
      tone: alreadyResolved ? 'info' : 'error',
    });
    return false;
  }
}

/**
 * "Continue" (A.10, ADR-016): resumes the session; the server closes the expired cards
 * (`decision.resolved` with outcome `expired`).
 */
export async function resumeSession(sessionKey: string, expired: readonly DecisionId[]): Promise<boolean> {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return false;
  markLocalResolution(expired);
  try {
    await sendCommand(sessionKey, { name: 'session.resume', entryId: parsed.entryId });
    return true;
  } catch (caught) {
    for (const id of expired) unmarkLocalResolution(id);
    showErrorNotice(errorPayloadOf(caught), { sessionKey, id: `decisions.resume.${sessionKey}` });
    return false;
  }
}
