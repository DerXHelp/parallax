import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { parseSessionKey, type DecisionId } from '@shared/common';
import type { PlanAnnotation, PlanDecision } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';

/**
 * WP-93 (ADR-234): annotations of an open plan decision. The server keeps them in the decision
 * (`decision.annotatePlan` replaces the whole list, every window gets `decision.upsert`); this
 * window shows its own change at once: an overlay per decision until the decision from the server
 * carries the same list (echo and ack may come in either order; after the ack at most
 * `SETTLE_AFTER_ACK_MS`, then the server's list wins). On a failure the server's list is shown
 * again (notice).
 */

interface Pending {
  annotations: readonly PlanAnnotation[];
  token: number;
  /** The server accepted the change (its echo may still be on the way). */
  acked: boolean;
}

/** Longest wait for the echo after the ack (another window may have changed the list meanwhile). */
export const SETTLE_AFTER_ACK_MS = 2_000;

const store = createStore<Readonly<Record<DecisionId, Pending>>>(() => ({}));
let nextToken = 0;

const NONE: readonly PlanAnnotation[] = [];

function sameAnnotations(a: readonly PlanAnnotation[], b: readonly PlanAnnotation[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, index) => {
      const y = b[index];
      return (
        x.id === y?.id &&
        x.kind === y.kind &&
        x.block === y.block &&
        x.quote === y.quote &&
        x.prefix === y.prefix &&
        x.suffix === y.suffix &&
        x.comment === y.comment &&
        x.createdAt === y.createdAt
      );
    })
  );
}

function shown(pending: Pending | undefined, decision: PlanDecision): readonly PlanAnnotation[] {
  if (pending === undefined) return decision.annotations;
  if (pending.acked && sameAnnotations(pending.annotations, decision.annotations)) return decision.annotations;
  return pending.annotations;
}

/** The annotations shown for `decision`: this window's unconfirmed change, else the server's. */
export function usePlanAnnotations(decision: PlanDecision | null): readonly PlanAnnotation[] {
  const pending = useStore(store, (state) => (decision === null ? undefined : state[decision.id]));
  return decision === null ? NONE : shown(pending, decision);
}

/** Non-reactive read (send path). */
export function getPlanAnnotations(decision: PlanDecision): readonly PlanAnnotation[] {
  return shown(store.getState()[decision.id], decision);
}

function settle(decisionId: DecisionId, token: number): void {
  // Replace, not merge: a merge would keep the removed key.
  store.setState((state) => {
    if (state[decisionId]?.token !== token) return state;
    const { [decisionId]: _done, ...rest } = state;
    return rest;
  }, true);
}

/** Replaces the annotations of the open plan decision; false when the server refused. */
export async function savePlanAnnotations(
  sessionKey: string,
  decision: PlanDecision,
  annotations: readonly PlanAnnotation[],
): Promise<boolean> {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return false;
  nextToken += 1;
  const token = nextToken;
  store.setState((state) => ({ ...state, [decision.id]: { annotations, token, acked: false } }));
  try {
    await sendCommand(sessionKey, {
      name: 'decision.annotatePlan',
      entryId: parsed.entryId,
      decisionId: decision.id,
      annotations: [...annotations],
    });
  } catch (caught) {
    settle(decision.id, token);
    showErrorNotice(errorPayloadOf(caught), { sessionKey, id: `decisions.annotate.${decision.id}` });
    return false;
  }
  store.setState((state) => {
    const pending = state[decision.id];
    return pending?.token === token ? { ...state, [decision.id]: { ...pending, acked: true } } : state;
  });
  setTimeout(() => {
    settle(decision.id, token);
  }, SETTLE_AFTER_ACK_MS);
  return true;
}

/** Tests. */
export function resetPlanAnnotations(): void {
  store.setState({}, true);
  nextToken = 0;
}
