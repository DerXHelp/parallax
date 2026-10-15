import type { SessionSummary } from '@shared/model';
import type { SessionSnapshot } from '@shared/protocol';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';

/**
 * Test helpers of the transcript feature (tests only; never imported by production code).
 * Tests still clean up the global stores themselves: `running.stop()` and `resetClientStore()`
 * in `afterEach` (R1-web hint).
 */

function rect(width: number, height: number): DOMRectReadOnly {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({ width, height }),
  };
}

/**
 * happy-dom does not lay out: a ResizeObserver that reports `viewport` px for the transcript's
 * scroll container (role="region") and `item` px for every row, so virtua renders a window of rows.
 */
export function installResizeObserver(options: { viewport?: number; item?: number } = {}): () => void {
  const viewport = options.viewport ?? 600;
  const item = options.item ?? 48;
  const original = window.ResizeObserver;

  class FakeResizeObserver implements ResizeObserver {
    private readonly callback: ResizeObserverCallback;
    private readonly targets = new Set<Element>();

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element): void {
      this.targets.add(target);
      const height = target.getAttribute('role') === 'region' ? viewport : item;
      queueMicrotask(() => {
        if (!this.targets.has(target)) return;
        this.callback(
          [
            {
              target,
              contentRect: rect(800, height),
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            },
          ],
          this,
        );
      });
    }

    unobserve(target: Element): void {
      this.targets.delete(target);
    }

    disconnect(): void {
      this.targets.clear();
    }
  }

  window.ResizeObserver = FakeResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver;
  // virtua only takes item sizes of laid-out elements (`offsetParent !== null`); until then the
  // rows stay `visibility: hidden` – invisible to role queries.
  const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
  return () => {
    window.ResizeObserver = original;
    globalThis.ResizeObserver = original;
    if (offsetParent === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent');
    else Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent);
  };
}

/** Starts the WP-14 "empty" scenario (FakeHost + real HostConnection) with the given sessions. */
export function startTranscriptScenario(
  sessions: readonly { snapshot: SessionSnapshot; summary?: SessionSummary }[],
): RunningScenario {
  const running = startScenario('empty', { select: null });
  for (const session of sessions) {
    running.host.addSession(session.snapshot);
    if (session.summary !== undefined) running.host.upsertSummary(session.summary);
  }
  return running;
}
