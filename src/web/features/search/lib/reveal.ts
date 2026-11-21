import { requestShell, type ShellRequestOf } from '@web/shell/requests';

/**
 * The jump to a hit (WP-115): the dialog selects the session, then asks for `revealItem`. The
 * transcript of that session mounts a moment later (React render, lazy chunk), so the request is
 * repeated until a transcript takes it – at most `REVEAL_TIMEOUT_MS`. A newer jump cancels an older
 * one that is still waiting.
 */

export const REVEAL_RETRY_MS = 100;
export const REVEAL_TIMEOUT_MS = 10_000;

let cancelPending: (() => void) | null = null;

/** Stops a jump that still waits for its transcript (tests; a new jump does it itself). */
export function cancelPendingReveal(): void {
  cancelPending?.();
}

export function revealSearchHit(
  request: ShellRequestOf<'revealItem'>,
  send: (request: ShellRequestOf<'revealItem'>) => boolean = requestShell,
): void {
  cancelPendingReveal();
  if (send(request)) return;
  const started = Date.now();
  const timer = setInterval(() => {
    if (send(request) || Date.now() - started >= REVEAL_TIMEOUT_MS) cancel();
  }, REVEAL_RETRY_MS);
  const cancel = () => {
    clearInterval(timer);
    if (cancelPending === cancel) cancelPending = null;
  };
  cancelPending = cancel;
}
