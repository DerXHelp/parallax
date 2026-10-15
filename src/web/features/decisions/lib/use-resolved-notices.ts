import { useEffect, useRef } from 'react';
import type { ConversationId } from '@shared/common';
import type { Decision } from '@shared/model';
import { useSessionMeta, useSessionSelector } from '@web/state/hooks';
import { showTextNotice } from '@web/state/notices';
import { isLocalResolution } from '../state/bar-store';
import { NO_OUTCOMES, resolvedElsewhereNotice, selectDecisionOutcomes } from './outcomes';

interface Seen {
  sessionKey: string;
  conversationId: ConversationId | null;
  hasView: boolean;
  decisions: readonly Decision[];
}

/**
 * `decisionResolved` from elsewhere (A.2 "first click wins"): when a decision disappears that this
 * window did not answer, the card simply goes away and a short local hint says why (answered in
 * another window, withdrawn by Claude …; architecture §2.3i). Resyncs, conversation resets and
 * session switches never produce hints.
 */
export function useResolvedElsewhereNotices(sessionKey: string, decisions: readonly Decision[]): void {
  const meta = useSessionMeta(sessionKey);
  const outcomes = useSessionSelector(sessionKey, selectDecisionOutcomes, NO_OUTCOMES);
  const seen = useRef<Seen | null>(null);

  useEffect(() => {
    const previous = seen.current;
    seen.current = { sessionKey, conversationId: meta.conversationId, hasView: meta.hasView, decisions };
    if (
      previous === null ||
      previous.decisions === decisions ||
      previous.sessionKey !== sessionKey ||
      !previous.hasView ||
      !meta.hasView ||
      previous.conversationId !== meta.conversationId
    ) {
      return;
    }
    const current = new Set(decisions.map((decision) => decision.id));
    for (const decision of previous.decisions) {
      if (current.has(decision.id) || isLocalResolution(decision.id)) continue;
      showTextNotice(resolvedElsewhereNotice(outcomes.get(decision.id) ?? null), undefined, {
        sessionKey,
        id: `decisions.resolved.${decision.id}`,
      });
    }
  }, [decisions, meta.conversationId, meta.hasView, outcomes, sessionKey]);
}
