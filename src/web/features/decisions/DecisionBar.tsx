import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { DecisionId } from '@shared/common';
import type { Decision } from '@shared/model';
import { useT, type t as translateFn } from '@web/i18n';
import { findDecisionBar, useDecisionFocusHandler } from '@web/shell/decision-focus';
import { useDecisions } from '@web/state/hooks';
import { DecisionView } from './components/DecisionView';
import { QueueMenu } from './components/QueueMenu';
import { useResolvedElsewhereNotices } from './lib/use-resolved-notices';
import { pickDisplayedDecision, selectDecision, useSelectedDecisionId } from './state/bar-store';

function announcement(decision: Decision | null, t: typeof translateFn): string {
  if (decision === null) return '';
  if (decision.state === 'expired') return t('decisions.bar.announce.expired');
  switch (decision.kind) {
    case 'permission':
      return t('decisions.bar.announce.permission', {
        title: decision.title ?? decision.displayName ?? decision.toolName,
      });
    case 'question':
      return t('decisions.bar.announce.question');
    case 'plan':
      return t('decisions.bar.announce.plan', { version: decision.version });
  }
}

function findCard(root: HTMLElement | null, decisionId: DecisionId): HTMLElement | null {
  if (root === null) return null;
  for (const card of root.querySelectorAll<HTMLElement>('[data-decision-id]')) {
    if (card.dataset.decisionId === decisionId) return card;
  }
  return null;
}

/**
 * Slot `DecisionBar` (Plan "Plan-Modus & Plan-Freigabe", Review A.6): a narrow, docked,
 * NON-modal bar above the composer. It shows the oldest open decision (or the one picked from
 * "+n more") as the ONLY operable card of the session (architecture §2.3e) and names who asks.
 * Nothing here ever takes the focus by itself: a new decision is announced politely
 * (`role="status"`), the focus moves into the bar only through "Go to decision"
 * (`useDecisionFocusHandler`) or the user's own clicks. After an answer given from inside the bar
 * the focus stays in the bar (not on a button of the next decision) – with a visible focus ring
 * (R2W-19).
 */
export const DecisionBar = memo(function DecisionBar({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const decisions = useDecisions(sessionKey);
  const selectedId = useSelectedDecisionId(sessionKey);
  const displayed = pickDisplayedDecision(decisions, selectedId);
  const rootRef = useRef<HTMLElement>(null);
  /** The user is working inside the bar (pointer/keys there, focus not moved elsewhere). */
  const interacting = useRef(false);

  useResolvedElsewhereNotices(sessionKey, decisions);

  useDecisionFocusHandler(sessionKey, (decisionId) => {
    if (!decisions.some((decision) => decision.id === decisionId)) return false;
    flushSync(() => {
      selectDecision(sessionKey, decisionId);
    });
    const card = findCard(rootRef.current, decisionId);
    if (card === null) return false;
    card.focus();
    card.scrollIntoView({ block: 'nearest' });
    return true;
  });

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root === null || !(event.target instanceof Node) || !root.contains(event.target)) {
        interacting.current = false;
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  const displayedId = displayed?.id ?? null;
  useLayoutEffect(() => {
    // The card the user worked in was replaced (answered, or resolved elsewhere): keep the focus
    // in the bar instead of dropping it to <body> – never move it when it is somewhere else.
    if (!interacting.current) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    interacting.current = false;
    (rootRef.current ?? findDecisionBar(sessionKey))?.focus();
  }, [displayedId, sessionKey]);

  const pick = (decisionId: DecisionId) => {
    flushSync(() => {
      selectDecision(sessionKey, decisionId);
    });
    findCard(rootRef.current, decisionId)?.focus();
  };

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement(displayed, t)}
      </div>
      {displayed === null ? null : (
        <section
          ref={rootRef}
          data-slot="decision-bar"
          aria-label={t('decisions.bar.label')}
          tabIndex={-1}
          className="focus-visible:ring-ring rounded-md px-3 pb-2 outline-none focus-visible:ring-2 focus-visible:ring-inset"
          onPointerDownCapture={() => {
            interacting.current = true;
          }}
          onKeyDownCapture={() => {
            interacting.current = true;
          }}
          onBlurCapture={(event) => {
            const next = event.relatedTarget;
            // Focus moved to another element: the user left the bar (null = nowhere, keep it).
            if (next instanceof Node && !event.currentTarget.contains(next)) interacting.current = false;
          }}
        >
          <DecisionView
            key={displayed.id}
            sessionKey={sessionKey}
            decision={displayed}
            headerExtra={
              decisions.length > 1 ? (
                <QueueMenu decisions={decisions} displayedId={displayed.id} onPick={pick} />
              ) : null
            }
          />
        </section>
      )}
    </>
  );
});
