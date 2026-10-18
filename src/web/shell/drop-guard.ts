/**
 * Window-wide drop guard (R4W-02): a file dropped next to the composer – on the transcript, the
 * sidebar, the header – would make Edge open it in the app window (`file:///…png`), Parallax and
 * its connection would be gone. A dragged link does the same unless it lands in a text field.
 *
 * Drop zones (the composer) handle `dragover`/`drop` themselves and call `preventDefault()`; this
 * listener runs after them (window, bubble phase) and refuses everything they left: no drop cursor
 * (`dropEffect = 'none'`), no navigation. Text drags into fields stay untouched.
 */

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
}

/** The drag would navigate the window if nobody took it. */
function navigates(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? []);
  if (types.includes('Files')) return true;
  return types.includes('text/uri-list') && !isEditable(event.target);
}

function guard(event: DragEvent): void {
  if (event.defaultPrevented || !navigates(event)) return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none';
}

/** Installs the guard on the window; returns the remove function. */
export function installDropGuard(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  target.addEventListener('dragover', guard);
  target.addEventListener('drop', guard);
  return () => {
    target.removeEventListener('dragover', guard);
    target.removeEventListener('drop', guard);
  };
}
