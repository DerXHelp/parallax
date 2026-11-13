/**
 * README screenshots (WP-68): the three showcase demos of the playground
 * (`src/web/playground/showcase/`) in German, light and dark, as
 * `docs/screenshots/<name>-<light|dark>.png`. No Parallax server, no `claude`: the playground runs
 * on the Vite dev server only (FakeHost over the in-memory transport, `#playground=<id>&bare`).
 *
 * - Vite programmatically with the repo config on a free port (no file watcher, no HMR), headless
 *   Chrome via Playwright (`channel: 'chrome'`, never a visible window), viewport 1440×900,
 *   deviceScaleFactor 2.
 * - Fixed clock (`page.clock.setFixedTime`, the showcase data are relative to it), time zone
 *   Europe/Berlin, locale de-DE; the theme via `emulateMedia` (the showcase uses the setting
 *   "system"), the language is German in the showcase data.
 * - Before each shot: the demo's ready marker, fonts, no pending requests (lazy chunks, the German
 *   dictionary), no Shiki placeholder left, a short settle time; animations are frozen.
 * - ADR-154: below-normal priority first (inherited by Vite/esbuild and Chrome); Chrome and Vite
 *   are always closed in `finally`.
 *
 *   pnpm exec tsx --tsconfig tsconfig.tools.json scripts/screenshots.ts
 *   … scripts/screenshots.ts --only=overview,plan --theme=dark   # a subset
 *   … scripts/screenshots.ts --base-url=http://127.0.0.1:5175    # reuse a running `pnpm dev:web`
 *   … scripts/screenshots.ts --demo=shell-app-busy --out=<dir>    # any other playground demo
 */
import { mkdir, stat } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { z } from 'zod';
import { lowerProcessPriority } from '../repo.config.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The README shots: file name → playground demo. */
const SHOTS = {
  overview: 'showcase-overview',
  plan: 'showcase-plan',
  files: 'showcase-files',
} as const;
type ShotName = keyof typeof SHOTS;
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/** Must match SHOWCASE_NOW in src/web/playground/showcase/clock.ts (Thursday afternoon, Berlin). */
const SHOWCASE_NOW = '2026-11-12T14:37:00+01:00';
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;
const SETTLE_MS = 700;
const READY_TIMEOUT_MS = 30_000;

const argsSchema = z.object({
  only: z.array(z.enum(Object.keys(SHOTS) as [ShotName, ...ShotName[]])).optional(),
  theme: z.enum(THEMES).optional(),
  baseUrl: z.url().optional(),
  demo: z
    .string()
    .regex(/^[a-z0-9/-]+$/)
    .optional(),
  out: z.string().min(1).optional(),
});
type Args = z.infer<typeof argsSchema>;

function parseArgs(argv: readonly string[]): Args {
  const raw: Record<string, unknown> = {};
  for (const arg of argv) {
    const match = /^--(only|theme|base-url|demo|out)=(.+)$/.exec(arg);
    if (match === null) throw new Error(`Unknown argument: ${arg}`);
    const [, key = '', value = ''] = match;
    if (key === 'only') raw.only = value.split(',');
    else if (key === 'base-url') raw.baseUrl = value;
    else raw[key] = value;
  }
  return argsSchema.parse(raw);
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

async function startVite(): Promise<{ server: ViteDevServer; url: string }> {
  const port = await freePort();
  const server = await createServer({
    configFile: path.join(repoRoot, 'vite.config.ts'),
    logLevel: 'warn',
    server: { port, strictPort: true, hmr: false, watch: null },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${String(port)}` };
}

/** Resolves once the page is quiet: no request in flight for `quietMs`. */
async function waitForQuietNetwork(page: Page, quietMs = 500, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  let inFlight = 0;
  let last = Date.now();
  const started = () => {
    inFlight++;
    last = Date.now();
  };
  const finished = () => {
    inFlight = Math.max(0, inFlight - 1);
    last = Date.now();
  };
  page.on('request', started);
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (inFlight === 0 && Date.now() - last >= quietMs) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('network did not become quiet');
  } finally {
    page.off('request', started);
    page.off('requestfinished', finished);
    page.off('requestfailed', finished);
  }
}

async function shoot(
  browser: Browser,
  baseUrl: string,
  demo: string,
  theme: Theme,
  file: string,
): Promise<void> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: theme,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.clock.setFixedTime(new Date(SHOWCASE_NOW));
    await page.goto(`${baseUrl}/#playground=${demo}&bare`);
    await page.locator(`[data-demo="${demo}"]`).waitFor({ timeout: READY_TIMEOUT_MS });
    // Showcase demos mark themselves ready once their scenario runs and the panels are set up.
    if (demo.startsWith('showcase-')) {
      await page.locator('[data-showcase-ready]').waitFor({ state: 'attached', timeout: READY_TIMEOUT_MS });
    }
    await waitForQuietNetwork(page);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // Shiki highlights asynchronously; plain placeholders carry data-highlight="pending" (if any).
    await page
      .locator('[data-highlight="pending"]')
      .first()
      .waitFor({ state: 'detached', timeout: READY_TIMEOUT_MS })
      .catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);
    await waitForQuietNetwork(page, 300);
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    if (errors.length > 0) out(`  console errors in ${demo} (${theme}):\n    ${errors.join('\n    ')}`);
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  lowerProcessPriority();
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(repoRoot, args.out ?? path.join('docs', 'screenshots'));
  await mkdir(outDir, { recursive: true });
  const themes: readonly Theme[] = args.theme === undefined ? THEMES : [args.theme];
  const jobs: { demo: string; name: string }[] =
    args.demo === undefined
      ? (args.only ?? (Object.keys(SHOTS) as ShotName[])).map((name) => ({ demo: SHOTS[name], name }))
      : [{ demo: args.demo, name: args.demo.replaceAll('/', '-') }];

  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  try {
    let baseUrl = args.baseUrl;
    if (baseUrl === undefined) {
      const started = await startVite();
      vite = started.server;
      baseUrl = started.url;
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    let total = 0;
    for (const job of jobs) {
      for (const theme of themes) {
        const file = path.join(outDir, `${job.name}-${theme}.png`);
        await shoot(browser, baseUrl, job.demo, theme, file);
        const { size } = await stat(file);
        total += size;
        out(`${path.relative(repoRoot, file)}  ${(size / 1024).toFixed(0)} KiB`);
      }
    }
    out(`total ${(total / 1024 / 1024).toFixed(2)} MiB`);
  } finally {
    await browser?.close();
    await vite?.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
