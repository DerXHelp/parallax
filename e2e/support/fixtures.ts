/**
 * Playwright fixtures of the Parallax E2E tests (WP-20c):
 * - `server` (worker): one real server per worker (FakeBackend, own temp PARALLAX_HOME, port 0),
 *   stopped with `server.shutdown` + clean-exit check at the end of the worker.
 * - `app`: the default page, signed in like the launcher (`/#code=…`) and connected.
 * - `newWindow()`: another signed-in window – a second page of the same context (same Edge
 *   profile, same cookie) or, with `{ context: 'new' }`, of a fresh context (own cookie/storage).
 * - Diagnostics in every context: a CSP violation (`securitypolicyviolation`, R2W-07 f) or an
 *   uncaught page error fails the test; console errors are attached to the report.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { ParallaxApp } from './app';
import { startE2eServer, type E2eServer } from './server';

interface Diagnostics {
  csp: string[];
  pageErrors: string[];
  consoleErrors: string[];
  /** Last WS frames of every page (attached when a test fails). */
  frames: string[];
}

/** WS frames kept for the failure report. */
const FRAMES_KEPT = 400;
/** Characters of one frame in the report. */
const FRAME_CHARS = 600;
/** Server log lines attached to a failed test. */
const SERVER_LOG_LINES = 200;

/**
 * Blocked loads that come from the machine, not from Parallax: security software injecting its
 * own script into every page (e.g. Kaspersky's `*.kaspersky-labs.com/…/main.js`). The page CSP
 * blocks them, which is correct – they must not fail the test. Everything else does.
 */
const FOREIGN_INJECTIONS = [/^https?:\/\/[^/]*\.kaspersky-labs\.com\//i];

interface WindowOptions {
  /** 'same' (default): a new page in the test's context; 'new': a fresh browser context. */
  context?: 'same' | 'new';
  /** Rest hash after the code (e.g. `session=local:en_…`). */
  hash?: string;
  /** Extra init script (before the page's own scripts). */
  init?: () => void;
  /** Context options of a fresh context (permissions …). */
  contextOptions?: Parameters<Browser['newContext']>[0];
}

interface TestFixtures {
  diagnostics: Diagnostics;
  app: ParallaxApp;
  newWindow: (options?: WindowOptions) => Promise<ParallaxApp>;
}

interface WorkerFixtures {
  server: E2eServer;
}

/** Writes `lines` into the test's output folder (test-results/, git-ignored) and attaches the file. */
async function attachText(testInfo: TestInfo, name: string, lines: readonly string[]): Promise<void> {
  const file = testInfo.outputPath(name);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  await testInfo.attach(name, { path: file, contentType: 'text/plain' });
}

/** Runs in every document before its scripts: reports CSP violations to the test. */
function reportCspViolations(): void {
  document.addEventListener('securitypolicyviolation', (event) => {
    const report = (window as unknown as { __e2eCsp?: (blocked: string, detail: string) => void }).__e2eCsp;
    report?.(
      event.blockedURI,
      `${event.effectiveDirective} blocked ${event.blockedURI} (${event.sourceFile}:${String(event.lineNumber)})`,
    );
  });
}

async function instrument(context: BrowserContext, diagnostics: Diagnostics): Promise<void> {
  await context.exposeFunction('__e2eCsp', (blocked: string, detail: string) => {
    if (FOREIGN_INJECTIONS.some((pattern) => pattern.test(blocked))) return;
    diagnostics.csp.push(detail);
  });
  await context.addInitScript(reportCspViolations);
  let pageNo = 0;
  const watch = (page: Page) => {
    pageNo += 1;
    const tag = `p${String(pageNo)}`;
    page.on('pageerror', (error) => {
      diagnostics.pageErrors.push(`${page.url()}: ${error.stack ?? error.message}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.consoleErrors.push(`${page.url()}: ${message.text()}`);
    });
    page.on('websocket', (socket) => {
      const keep = (direction: string, payload: string | Buffer) => {
        const text = typeof payload === 'string' ? payload : payload.toString('utf8');
        diagnostics.frames.push(
          `${new Date().toISOString()} ${tag} ${direction} ${text.slice(0, FRAME_CHARS)}`,
        );
        if (diagnostics.frames.length > FRAMES_KEPT) diagnostics.frames.shift();
      };
      socket.on('framesent', (frame) => {
        keep('>>', frame.payload);
      });
      socket.on('framereceived', (frame) => {
        keep('<<', frame.payload);
      });
      socket.on('close', () => {
        diagnostics.frames.push(`${new Date().toISOString()} ${tag} closed`);
      });
    });
  };
  for (const page of context.pages()) watch(page);
  context.on('page', watch);
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  server: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the object pattern
    async ({}, use, workerInfo) => {
      const label = `w${String(workerInfo.workerIndex)}`;
      const server = await startE2eServer({ label });
      try {
        await use(server);
      } finally {
        // The worker's whole server log stays as an artifact (test-results/, git-ignored).
        await server.stop(async (lines) => {
          await mkdir(workerInfo.project.outputDir, { recursive: true });
          await writeFile(
            path.join(workerInfo.project.outputDir, `server-${label}.log`),
            `${lines.join('\n')}\n`,
          );
        });
      }
    },
    { scope: 'worker', timeout: 120_000 },
  ],

  diagnostics: [
    async ({ context }, use, testInfo) => {
      const diagnostics: Diagnostics = { csp: [], pageErrors: [], consoleErrors: [], frames: [] };
      await instrument(context, diagnostics);
      await use(diagnostics);
      if (testInfo.status !== testInfo.expectedStatus && diagnostics.frames.length > 0) {
        await attachText(testInfo, 'ws-frames.txt', diagnostics.frames);
      }
      if (diagnostics.consoleErrors.length > 0) {
        await attachText(testInfo, 'console-errors.txt', diagnostics.consoleErrors);
      }
      expect(diagnostics.csp, 'CSP violations (R2W-07 f)').toEqual([]);
      expect(diagnostics.pageErrors, 'uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],

  // `diagnostics` first: the page is instrumented before it opens the app.
  app: async ({ page, server, diagnostics: _diagnostics }, use, testInfo) => {
    const app = new ParallaxApp(page, server);
    await app.open();
    await use(app);
    if (testInfo.status !== testInfo.expectedStatus) {
      const lines = await server.logLines();
      await attachText(testInfo, 'server-log.txt', lines.slice(-SERVER_LOG_LINES));
    }
  },

  newWindow: async ({ browser, context, server, diagnostics }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    const open = async (options: WindowOptions = {}): Promise<ParallaxApp> => {
      let target = context;
      if (options.context === 'new') {
        target = await browser.newContext({
          viewport: testInfo.project.use.viewport ?? null,
          ...options.contextOptions,
        });
        contexts.push(target);
        await instrument(target, diagnostics);
      }
      if (options.init !== undefined) await target.addInitScript(options.init);
      const page = await target.newPage();
      return new ParallaxApp(page, server).open(options.hash ?? '');
    };
    await use(open);
    for (const extra of contexts) await extra.close();
  },
});

export { expect };
