import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Focus return for dialogs opened without a Radix `DialogTrigger` – by a shortcut, the shell
 * request channel or a menu item (R4W-04, V3-04). Radix gives the focus back only to its trigger;
 * without one it ends on `<body>` and the next Tab starts at the top of the page.
 *
 * Usage: `const onCloseAutoFocus = useReturnFocus(open, fallback)` and
 * `<DialogContent onCloseAutoFocus={onCloseAutoFocus}>`. The hook remembers the focused element
 * when `open` turns true (a layout effect, before the dialog moves the focus inside). The handler
 * cancels Radix' default and focuses that element again – or `fallback()` when it is gone (the item
 * of a menu that closed meanwhile) or cannot take the focus. A component that is mounted only
 * while its dialog is open passes `true`.
 */
export function useReturnFocus(open: boolean, fallback?: () => HTMLElement | null): (event: Event) => void {
  const saved = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const fallbackRef = useRef(fallback);

  useLayoutEffect(() => {
    fallbackRef.current = fallback;
  });

  useLayoutEffect(() => {
    // Only the transition closed → open counts (StrictMode re-runs effects with the focus
    // already inside the dialog).
    if (open && !wasOpen.current) saved.current = focusedElement();
    wasOpen.current = open;
  }, [open]);

  return useCallback((event: Event) => {
    event.preventDefault();
    const target = saved.current;
    saved.current = null;
    if (focusElement(target)) return;
    focusElement(fallbackRef.current?.() ?? null);
  }, []);
}

/** The focused element of the document, null for `<body>` (nothing focused). */
export function focusedElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * Focuses `element` if it is still in the document and takes the focus (not hidden, disabled or
 * inert); true when the focus is there now.
 */
export function focusElement(element: HTMLElement | null): boolean {
  if (element === null || !element.isConnected || element.hidden) return false;
  if (element.closest('[inert]') !== null) return false;
  element.focus();
  return document.activeElement === element;
}
