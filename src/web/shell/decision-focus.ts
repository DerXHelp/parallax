import { useEffect, useEffectEvent } from 'react';
import type { DecisionId } from '@shared/common';

/**
 * "Go to decision" (architecture §2.3e, ADR-031): a decision has exactly ONE operable instance –
 * the card in the decision bar (`placement: 'bar'`). The read-only transcript card
 * (`placement: 'transcript'`) offers a button that calls `focusDecision(sessionKey, decisionId)`.
 * The DecisionBar (WP-16) registers a handler per session that brings the decision into view
 * (e.g. switches to it) and focuses it; without a handler the bar region of the pane
 * (`[data-decision-bar="<sessionKey>"]`, rendered by SessionPane) receives the focus.
 * Only ever called from a user action – never to steal the focus for a new decision.
 */

/** Return true when the decision was shown and focused. */
export type DecisionFocusHandler = (decisionId: DecisionId) => boolean;

const handlers = new Map<string, DecisionFocusHandler[]>();

/** Registers a handler for one session (newest first); returns the remove function. */
export function registerDecisionFocusHandler(sessionKey: string, handler: DecisionFocusHandler): () => void {
  const list = handlers.get(sessionKey) ?? [];
  list.push(handler);
  handlers.set(sessionKey, list);
  return () => {
    const current = handlers.get(sessionKey);
    if (current === undefined) return;
    const index = current.indexOf(handler);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) handlers.delete(sessionKey);
  };
}

/** For the DecisionBar (WP-16): handles "Go to decision" for its session while mounted. */
export function useDecisionFocusHandler(sessionKey: string, handler: DecisionFocusHandler): void {
  const run = useEffectEvent((decisionId: DecisionId) => handler(decisionId));
  useEffect(() => registerDecisionFocusHandler(sessionKey, (decisionId) => run(decisionId)), [sessionKey]);
}

/** The decision bar region of the pane showing `sessionKey` (null if not rendered). */
export function findDecisionBar(sessionKey: string, root: ParentNode = document): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>('[data-decision-bar]')) {
    if (element.dataset.decisionBar === sessionKey) return element;
  }
  return null;
}

/**
 * Moves the focus to the operable instance of a decision: the registered bar handler, else the
 * card `[data-decision-id]` inside the bar region, else the region itself. Returns false when
 * the session's pane is not shown.
 */
export function focusDecision(
  sessionKey: string,
  decisionId: DecisionId,
  root: ParentNode = document,
): boolean {
  const list = handlers.get(sessionKey) ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.(decisionId) === true) return true;
  }
  const bar = findDecisionBar(sessionKey, root);
  if (bar === null) return false;
  let target: HTMLElement = bar;
  for (const card of bar.querySelectorAll<HTMLElement>('[data-decision-id]')) {
    if (card.dataset.decisionId === decisionId) {
      target = card;
      break;
    }
  }
  target.focus();
  return true;
}
