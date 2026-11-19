import { LIMITS, parseSessionKey, type BlobId, type PromptPriority } from '@shared/common';
import type { Decision, DecisionResponse, PlanAnnotation } from '@shared/model';
import type { TranslationKey, TranslationParams } from '@web/i18n';
import { buildPlanFeedback } from '@web/lib/plan-feedback';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';

/**
 * Commands of the composer. Failures become local notices (architecture §2.3i); the caller keeps
 * or restores the text.
 */

/** A question decision the composer text answers directly (exactly one question, R2W-13). */
export function isSingleQuestion(decision: Decision): boolean {
  return decision.kind === 'question' && decision.questions.length === 1;
}

/**
 * Max text length per send target (contract limits of the prompt and of the answers, R2W-12).
 * `overhead`: characters the plan's annotations add to the feedback (WP-93, `feedbackOverhead`).
 */
export function textLimit(target: Decision | null, overhead = 0): number {
  if (target === null) return LIMITS.promptChars;
  if (target.kind === 'plan') return Math.max(0, LIMITS.planFeedbackChars - overhead);
  if (isSingleQuestion(target)) return LIMITS.answerChars;
  return LIMITS.decisionMessageChars;
}

/**
 * Composer text as the answer to an open decision (Plan "Plan-Modus", WP-13 §3.4): "No, instead:
 * …" = permission deny + message; one question = answer with the text as "Other" (R2W-13),
 * several questions = decline + message; plan revise (feedback – WP-93: with the plan's
 * annotations, the text as the general part; `annotations` = this window's view of them). Typing
 * can never approve.
 */
export function answerFromText(
  decision: Decision,
  text: string,
  t: (key: TranslationKey, params?: TranslationParams) => string,
  annotations?: readonly PlanAnnotation[],
): DecisionResponse {
  switch (decision.kind) {
    case 'permission':
      return { kind: 'permission', response: { behavior: 'deny', message: text, interrupt: false } };
    case 'question': {
      const [only] = decision.questions;
      if (only !== undefined && decision.questions.length === 1) {
        return {
          kind: 'question',
          response: {
            behavior: 'answer',
            answers: [{ question: only.question, selected: [], otherText: text, notes: null }],
          },
        };
      }
      return { kind: 'question', response: { behavior: 'decline', message: text } };
    }
    case 'plan':
      return {
        kind: 'plan',
        response: {
          behavior: 'revise',
          feedback: buildPlanFeedback(decision.plan, annotations ?? decision.annotations, text, t),
        },
      };
  }
}

/**
 * Sends a prompt; `attachments` are blob ids of uploaded images, PDFs and files (ADR-103/146) – the
 * text may then be empty; `pastes` are pasted texts that stand verbatim in `text` (ADR-146).
 */
export async function sendPrompt(
  sessionKey: string,
  text: string,
  priority: PromptPriority,
  attachments: readonly BlobId[] = [],
  pastes: readonly string[] = [],
): Promise<boolean> {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return false;
  try {
    await sendCommand(sessionKey, {
      name: 'session.sendPrompt',
      entryId: parsed.entryId,
      prompt: { text, attachments: attachments.map((blobId) => ({ blobId })), pastes: [...pastes] },
      priority,
    });
    return true;
  } catch (caught) {
    showErrorNotice(errorPayloadOf(caught), { sessionKey, id: `composer.send.${sessionKey}` });
    return false;
  }
}

export async function interruptSession(sessionKey: string): Promise<boolean> {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return false;
  try {
    await sendCommand(sessionKey, { name: 'session.interrupt', entryId: parsed.entryId });
    return true;
  } catch (caught) {
    showErrorNotice(errorPayloadOf(caught), { sessionKey, id: `composer.stop.${sessionKey}` });
    return false;
  }
}
