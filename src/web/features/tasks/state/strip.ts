import { useCallback, useState } from 'react';
import { readStorage, storageKey, writeStorage } from '@web/lib/storage';

/**
 * Expanded state of the task strip per session (WP-55), kept in localStorage – collapsed by default.
 * The storage helpers swallow every error (missing/defective storage): then the state lives only
 * as long as the strip.
 */

function keyOf(sessionKey: string): string {
  return storageKey('tasks', 'strip', sessionKey);
}

export function readStripExpanded(sessionKey: string): boolean {
  return readStorage('local', keyOf(sessionKey)) === 'expanded';
}

export function writeStripExpanded(sessionKey: string, expanded: boolean): void {
  writeStorage('local', keyOf(sessionKey), expanded ? 'expanded' : null);
}

export function useStripExpanded(sessionKey: string): [boolean, (expanded: boolean) => void] {
  const [state, setState] = useState(() => ({ sessionKey, expanded: readStripExpanded(sessionKey) }));
  // Another session in the same pane: read its own state (no effect needed – derived on render).
  let current = state;
  if (state.sessionKey !== sessionKey) {
    current = { sessionKey, expanded: readStripExpanded(sessionKey) };
    setState(current);
  }
  const setExpanded = useCallback(
    (expanded: boolean) => {
      writeStripExpanded(sessionKey, expanded);
      setState({ sessionKey, expanded });
    },
    [sessionKey],
  );
  return [current.expanded, setExpanded];
}
