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

/** Reports of the installed fake ResizeObservers, keyed by observed element (`reportResize`). */
const resizeReporters = new Set<(target: Element, height: number) => void>();

/** Simulates a new height of an observed element (e.g. a larger window for the list's region). */
export function reportResize(target: Element, height: number): void {
  for (const report of resizeReporters) report(target, height);
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
    private readonly reporter = (target: Element, height: number): void => {
      if (this.targets.has(target)) this.report(target, height);
    };

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      resizeReporters.add(this.reporter);
    }

    private report(target: Element, height: number): void {
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
    }

    observe(target: Element): void {
      this.targets.add(target);
      const height = target.getAttribute('role') === 'region' ? viewport : item;
      queueMicrotask(() => {
        if (this.targets.has(target)) this.report(target, height);
      });
    }

    unobserve(target: Element): void {
      this.targets.delete(target);
    }

    disconnect(): void {
      this.targets.clear();
      resizeReporters.delete(this.reporter);
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
    resizeReporters.clear();
    window.ResizeObserver = original;
    globalThis.ResizeObserver = original;
    if (offsetParent === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent');
    else Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent);
  };
}

/**
 * happy-dom stores `scrollTop` but never fires `scroll` for a programmatic change; browsers do (after
 * the change, asynchronously). The transcript scrolls to the end by writing `scrollTop`, and virtua
 * learns the offset only from that event – this emulates it (a microtask after a real change).
 */
export function installScrollEvents(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  const getter: unknown = descriptor === undefined ? undefined : Reflect.get(descriptor, 'get');
  const setter: unknown = descriptor === undefined ? undefined : Reflect.get(descriptor, 'set');
  if (descriptor === undefined || typeof getter !== 'function' || typeof setter !== 'function')
    return () => undefined;
  const read = (element: Element): unknown => Reflect.apply(getter, element, []);
  const write = (element: Element, value: number): void => {
    Reflect.apply(setter, element, [value]);
  };
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element): unknown {
      return read(this);
    },
    set(this: Element, value: number) {
      const before = read(this);
      write(this, value);
      const after = read(this);
      if (after === before) return;
      queueMicrotask(() => {
        this.dispatchEvent(new Event('scroll'));
      });
    },
  });
  return () => {
    Object.defineProperty(Element.prototype, 'scrollTop', descriptor);
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
