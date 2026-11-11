import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import { SAMPLE_IDS, sampleSessionSnapshot, sampleSummary } from '@shared/samples';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import type { FakeHost } from '@web/state/fake-host';
import { FileLoadError, type FileSource } from './state/file-source';

/**
 * Test helpers of the files feature (tests and the playground; never imported by production code).
 * Tests clean up the global state themselves: `running.stop()`, `resetClientStore()`,
 * `setFileSource(null)` and `statCache.clear()` in `afterEach`.
 */

export const FILES_SESSION_KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);

/** The "empty" scenario plus the sample session (cwd `D:\work\sample`) on the FakeHost. */
export function startFilesScenario(): RunningScenario {
  const running = startScenario('empty', { select: null });
  running.host.addSession(sampleSessionSnapshot());
  running.host.upsertSummary(sampleSummary());
  return running;
}

/**
 * A FileSource over the fake host's table (no server): text from `host.fileText`, URLs from
 * `url` (default `fake:///…` – a data/blob URL in the playground). Unknown texts fail with
 * FILE_NOT_FOUND like GET /api/file.
 */
export function fakeHostFileSource(host: FakeHost, url?: (path: string) => string): FileSource {
  return {
    text: (file) => {
      const text = host.fileText(file.path);
      return text === null
        ? Promise.reject(new FileLoadError(makeError('FILE_NOT_FOUND')))
        : Promise.resolve(text);
    },
    url: (file) => url?.(file.path) ?? `fake:///${encodeURIComponent(file.path)}`,
  };
}

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
 * happy-dom does not lay out: a ResizeObserver that reports `viewport` px for scroll containers of
 * virtualized lists (`role="region"`/`role="list"`) and `item` px for everything else, so virtua
 * renders a window of rows. Also makes `offsetParent` non-null (virtua measures laid-out rows only).
 */
export function installResizeObserver(options: { viewport?: number; item?: number } = {}): () => void {
  const viewport = options.viewport ?? 400;
  const item = options.item ?? 20;
  const original = window.ResizeObserver;

  class FakeResizeObserver implements ResizeObserver {
    private readonly callback: ResizeObserverCallback;
    private readonly targets = new Set<Element>();

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element): void {
      this.targets.add(target);
      const role = target.getAttribute('role');
      const height = role === 'region' || role === 'list' ? viewport : item;
      queueMicrotask(() => {
        if (!this.targets.has(target)) return;
        this.callback(
          [
            {
              target,
              contentRect: rect(600, height),
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
