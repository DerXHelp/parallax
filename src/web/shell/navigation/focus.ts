/**
 * Where the focus goes for a session when the element that had it is gone (a menu item, a row
 * that moved, an inline field): the "…" button of its header or its sidebar row – used by the
 * inline rename and the navigation dialogs (R4W-04, V3-04; `useReturnFocus` in `lib/return-focus.ts`).
 */
export type SessionFocusPlace = 'header' | 'sidebar';

/** The preferred element of the session, else the other one; null when neither is shown. */
export function sessionFocusTarget(
  sessionKey: string,
  prefer: SessionFocusPlace = 'header',
): HTMLElement | null {
  // Session keys are `host:en_<hex>` – safe inside a quoted attribute selector.
  const row = document.querySelector<HTMLElement>(`[data-session-row="${sessionKey}"]:not([hidden])`);
  const menu = document.querySelector<HTMLElement>(
    `[data-session-key="${sessionKey}"] [data-slot="session-menu"]`,
  );
  return prefer === 'sidebar' ? (row ?? menu) : (menu ?? row);
}
