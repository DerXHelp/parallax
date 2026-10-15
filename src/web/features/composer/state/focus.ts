import { useEffect, useEffectEvent } from 'react';

/**
 * "Keep planning" in the decision bar moves the focus into the composer of the same session –
 * only ever as the result of a user action (never for a new decision: no focus theft).
 */

type FocusTarget = () => void;

const targets = new Map<string, FocusTarget[]>();

/** Focuses the composer of `sessionKey`; false if none is mounted. */
export function requestComposerFocus(sessionKey: string): boolean {
  const list = targets.get(sessionKey);
  const target = list?.at(-1);
  if (target === undefined) return false;
  target();
  return true;
}

/** Registers the composer of a session as focus target while mounted (newest wins). */
export function useComposerFocusTarget(sessionKey: string, focus: FocusTarget): void {
  const run = useEffectEvent(() => {
    focus();
  });
  useEffect(() => {
    const entry: FocusTarget = () => {
      run();
    };
    const list = targets.get(sessionKey) ?? [];
    list.push(entry);
    targets.set(sessionKey, list);
    return () => {
      const current = targets.get(sessionKey);
      if (current === undefined) return;
      const index = current.indexOf(entry);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) targets.delete(sessionKey);
    };
  }, [sessionKey]);
}
