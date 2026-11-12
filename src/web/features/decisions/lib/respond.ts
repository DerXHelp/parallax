import { parseSessionKey, type DecisionId } from '@shared/common';
import { makeError, type ErrorCode, type ErrorPayload } from '@shared/errors';
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

export type RespondResult = { ok: true } | { ok: false; error: ErrorPayload };

/**
 * Codes the server checks BEFORE it resolves a plan decision for a fresh context (WP-51
 * freshContext.ts): the card is still there to show them. Any other failure (a start error) comes
 * after the decision closed – the card is gone, the DecisionBar reports it as a notice.
 */
const CHECKED_BEFORE_RESOLVING: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'SESSION_BUSY',
  'MODE_NOT_ALLOWED',
  'DECISION_NOT_FOUND',
  'DECISION_ALREADY_RESOLVED',
  'DECISION_EXPIRED',
  'DECISION_OPTION_UNAVAILABLE',
  'VALIDATION_FAILED',
]);

export function failsBeforeResolving(code: ErrorCode): boolean {
  return CHECKED_BEFORE_RESOLVING.has(code);
}

/**
 * Sends the answer. On a failure the "answered by this window" mark is dropped when the decision is
 * still open (`stillOpen`), so a later resolution elsewhere is reported again.
 */
async function send(
  sessionKey: string,
  decision: Decision,
  response: DecisionResponse,
  stillOpen: (code: ErrorCode) => boolean,
): Promise<RespondResult> {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return { ok: false, error: makeError('VALIDATION_FAILED', { path: 'sessionKey' }) };
  markLocalResolution([decision.id]);
  try {
    await sendCommand(sessionKey, {
      name: 'decision.respond',
      entryId: parsed.entryId,
      decisionId: decision.id,
      response,
    });
    return { ok: true };
  } catch (caught) {
    const error = errorPayloadOf(caught);
    if (stillOpen(error.code)) unmarkLocalResolution(decision.id);
    return { ok: false, error };
  }
}

function noticeId(decision: Decision): string {
  return `decisions.respond.${decision.id}`;
}

/** Sends the answer; resolves `true` once the server accepted it (the card then disappears). */
export async function respondToDecision(
  sessionKey: string,
  decision: Decision,
  response: DecisionResponse,
): Promise<boolean> {
  const result = await send(sessionKey, decision, response, (code) => code !== 'DECISION_ALREADY_RESOLVED');
  if (result.ok) return true;
  const alreadyResolved = result.error.code === 'DECISION_ALREADY_RESOLVED';
  showErrorNotice(result.error, {
    sessionKey,
    id: noticeId(decision),
    tone: alreadyResolved ? 'info' : 'error',
  });
  return false;
}

/**
 * Like respondToDecision, but a failure is returned for the card to show (WP-56: "fresh context"
 * errors such as SESSION_BUSY or MODE_NOT_ALLOWED appear in the card, `Alert role="alert"`). Only
 * "answered elsewhere first" stays a notice – that card disappears anyway. Any other failure (a
 * start error) comes after the server closed the decision for this answer: the mark stays, so its
 * `decision.resolved` – applied with the next frame, possibly after the ack – is no "answered
 * elsewhere" notice.
 */
export async function respondInCard(
  sessionKey: string,
  decision: Decision,
  response: DecisionResponse,
): Promise<RespondResult> {
  const result = await send(
    sessionKey,
    decision,
    response,
    (code) => code !== 'DECISION_ALREADY_RESOLVED' && failsBeforeResolving(code),
  );
  if (!result.ok && result.error.code === 'DECISION_ALREADY_RESOLVED') {
    showErrorNotice(result.error, { sessionKey, id: noticeId(decision), tone: 'info' });
  }
  return result;
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
