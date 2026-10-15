import { LIMITS, parseSessionKey, type PromptPriority } from '@shared/common';
import type { Decision, DecisionResponse } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';

/**
 * Commands of the composer. Failures become local notices (architecture §2.3i); the caller keeps
 * or restores the text.
 */

/** Max text length per send target (contract limits of the prompt and of the answers). */
export function textLimit(target: Decision | null): number {
  if (target === null) return LIMITS.promptChars;
  return target.kind === 'plan' ? 50_000 : 10_000;
}

/**
 * Composer text while a decision is open (Plan "Plan-Modus", WP-13 §3.4): "No, instead: …" =
 * permission deny + message, question decline + message, plan revise (feedback). Typing can never
 * approve anything.
 */
export function answerFromText(decision: Decision, text: string): DecisionResponse {
  switch (decision.kind) {
    case 'permission':
      return { kind: 'permission', response: { behavior: 'deny', message: text, interrupt: false } };
    case 'question':
      return { kind: 'question', response: { behavior: 'decline', message: text } };
    case 'plan':
      return { kind: 'plan', response: { behavior: 'revise', feedback: text } };
  }
}

export async function sendPrompt(
  sessionKey: string,
  text: string,
  priority: PromptPriority,
): Promise<boolean> {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return false;
  try {
    await sendCommand(sessionKey, {
      name: 'session.sendPrompt',
      entryId: parsed.entryId,
      prompt: { text, attachments: [] },
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
