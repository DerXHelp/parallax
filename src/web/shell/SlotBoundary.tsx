import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { showTextNotice } from '@web/state/notices';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';

/**
 * Error boundary of a lazily loaded area (WP-58, WP-50 §8 "Lazy-Slot-Fehlergrenze"): a chunk that
 * cannot be downloaded (Parallax updated meanwhile, server gone) or a render error inside the slot
 * shows a small card "This area could not be loaded" instead of unmounting the whole app; the rest
 * stays usable. "Reload" resets the boundary (render error) – a failed chunk stays failed in
 * `React.lazy`'s cache, so there it reloads the window after a confirmation. The error is only
 * shown, never logged (code rule: no `console.*`).
 *
 * Quiet variant (R5W-02): slots inside running text (a file reference in a paragraph, dozens per
 * transcript) pass a `fallback` – it replaces the card in place (inline, no `div` in a `p`, no
 * alert per reference), and the first quiet failure of the window is announced once as a notice.
 *
 * WP-60 wraps the lazy slots in App.tsx: `<SlotBoundary resetKey={sessionKey}>…</SlotBoundary>` or
 * `withSlotBoundary(Slot, (props) => props.sessionKey)`; inside a `Suspense`, the boundary goes
 * outside it.
 */

const CHUNK_ERROR =
  /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** True for a failed dynamic import (Chrome, Firefox, Safari wording and Vite's CSS preload). */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CHUNK_ERROR.test(`${error.name}: ${error.message}`);
}

export function reloadWindow(): void {
  window.location.reload();
}

/** What a quiet boundary's `fallback` learns about the failure. */
export interface SlotFailure {
  /** True for a chunk that could not be downloaded (only a window reload helps). */
  chunk: boolean;
}

/** Id of the one notice of quiet failures (R5W-02). */
export const QUIET_SLOT_NOTICE_ID = 'shell-slot-quiet-failure';

let quietFailureAnnounced = false;

/**
 * The first failure of a quiet boundary in this window becomes one notice (an error, so it is the
 * one `role="alert"`); every later one stays silent – the fallback already shows the content.
 */
function announceQuietFailure(chunk: boolean, reload: () => void): void {
  if (quietFailureAnnounced) return;
  quietFailureAnnounced = true;
  if (chunk) {
    showTextNotice('navigation.slotError.inlineChunk', undefined, {
      tone: 'error',
      id: QUIET_SLOT_NOTICE_ID,
      durationMs: null,
      action: { label: 'navigation.slotError.reloadWindow', run: reload },
    });
  } else {
    showTextNotice('navigation.slotError.inlineRender', undefined, {
      tone: 'error',
      id: QUIET_SLOT_NOTICE_ID,
    });
  }
}

/** Tests: the next quiet failure is announced again. */
export function resetQuietSlotFailures(): void {
  quietFailureAnnounced = false;
}

function SlotErrorCard({
  chunk,
  onRetry,
  onReloadWindow,
  className,
}: {
  chunk: boolean;
  onRetry: () => void;
  onReloadWindow: () => void;
  className?: string;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    // Keep the focus on the card's buttons when they swap (keyboard users stay in place).
    if (confirming) confirmRef.current?.focus();
    else if (wasConfirming.current) retryRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  return (
    <div data-slot="slot-error" data-error-kind={chunk ? 'chunk' : 'render'} className={cn('p-3', className)}>
      <Alert
        tone="error"
        className="mx-auto max-w-md"
        title={t('navigation.slotError.title')}
        actions={
          confirming ? (
            <>
              <Button ref={confirmRef} size="sm" onClick={onReloadWindow}>
                {t('navigation.slotError.reloadWindow')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                {t('navigation.slotError.cancel')}
              </Button>
            </>
          ) : (
            <Button
              ref={retryRef}
              size="sm"
              variant="outline"
              onClick={() => {
                if (chunk) setConfirming(true);
                else onRetry();
              }}
            >
              {t('navigation.slotError.retry')}
            </Button>
          )
        }
      >
        {confirming
          ? t('navigation.slotError.confirmReload')
          : chunk
            ? t('navigation.slotError.chunk')
            : t('navigation.slotError.render')}
      </Alert>
    </div>
  );
}

export interface SlotBoundaryProps {
  children: ReactNode;
  /** A change resets a caught error (e.g. the session key: another session gets a fresh try). */
  resetKey?: unknown;
  /** Classes of the error card's container (size it like the slot). */
  className?: string;
  /** Tests/playground: replaces `window.location.reload()`. */
  onReloadWindow?: () => void;
  /**
   * Quiet variant for slots inside running text (R5W-02): rendered instead of the card – e.g. a
   * file reference as plain text. Must be inline content when the slot sits in a paragraph. The
   * first quiet failure of the window is announced once as a notice.
   */
  fallback?: (failure: SlotFailure) => ReactNode;
}

interface SlotBoundaryState {
  failed: boolean;
  chunk: boolean;
  /** Bumped by "Reload": remounts the children instead of reusing their failed tree. */
  attempt: number;
}

export class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
  override state: SlotBoundaryState = { failed: false, chunk: false, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<SlotBoundaryState> {
    return { failed: true, chunk: isChunkLoadError(error) };
  }

  override componentDidCatch(error: unknown): void {
    if (this.props.fallback === undefined) return;
    announceQuietFailure(isChunkLoadError(error), this.props.onReloadWindow ?? reloadWindow);
  }

  override componentDidUpdate(previous: SlotBoundaryProps): void {
    if (this.state.failed && !Object.is(previous.resetKey, this.props.resetKey)) this.retry();
  }

  private readonly retry = (): void => {
    this.setState((state) => ({ failed: false, chunk: false, attempt: state.attempt + 1 }));
  };

  override render(): ReactNode {
    if (this.state.failed) {
      if (this.props.fallback !== undefined) return this.props.fallback({ chunk: this.state.chunk });
      return (
        <SlotErrorCard
          chunk={this.state.chunk}
          onRetry={this.retry}
          onReloadWindow={this.props.onReloadWindow ?? reloadWindow}
          className={this.props.className}
        />
      );
    }
    // The key remounts the slot after "Reload" (a fresh state, a new lazy attempt is not possible).
    return <SlotAttempt key={this.state.attempt}>{this.props.children}</SlotAttempt>;
  }
}

function SlotAttempt({ children }: { children: ReactNode }) {
  return children;
}

/**
 * `Slot` inside a SlotBoundary – for the FeatureSlots map (WP-60). `resetKeyOf` picks the reset key
 * from the props (usually the session key); `fallbackOf` makes it the quiet variant (R5W-02) with
 * the slot's own replacement, e.g. a file reference as plain text.
 */
export function withSlotBoundary<P extends object>(
  Slot: ComponentType<P>,
  resetKeyOf?: (props: P) => unknown,
  fallbackOf?: (props: P, failure: SlotFailure) => ReactNode,
): ComponentType<P> {
  function Bounded(props: P) {
    return (
      <SlotBoundary
        resetKey={resetKeyOf?.(props)}
        fallback={fallbackOf === undefined ? undefined : (failure) => fallbackOf(props, failure)}
      >
        <Slot {...props} />
      </SlotBoundary>
    );
  }
  Bounded.displayName = `SlotBoundary(${Slot.displayName ?? Slot.name})`;
  return Bounded;
}
