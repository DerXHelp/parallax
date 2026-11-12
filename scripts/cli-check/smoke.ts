/**
 * Step 3 of `pnpm cli-check` (WP-62): the existing live smoke `e2e/live` (WP-22) in Playwright –
 * `PARALLAX_LIVE=1`, the remaining budget as `PARALLAX_LIVE_BUDGET_USD` (checked before every prompt,
 * e2e/live/support/live.ts) – and what it left behind: the JSON report (test results, the
 * annotations `unknown-counts`/`validation-drops`) and `test-results/live-run.json` (temp root and
 * estimated cost of the run, written by the worker fixture). Parsing is pure and tested; the run
 * inherits the check's below-normal priority (ADR-154).
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { killProcessTree, spawnHidden } from '../../src/server/lib/process';

export const LIVE_RUN_FILE = 'live-run.json';

const countsSchema = z.record(z.string(), z.number());

export const smokeResultSchema = z.object({
  /** False when the smoke was not started (e.g. the probe already failed). */
  ran: z.boolean(),
  exitCode: z.number().nullable(),
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  flaky: z.number().int(),
  /** Failing tests (and global errors) with the first line of their error. */
  failures: z.array(z.object({ title: z.string(), message: z.string() })),
  /** Normalizer `unknownCounts` seen in the WS frames; null = not reported (test did not run). */
  unknownCounts: countsSchema.nullable(),
  /** "invalid … dropped" lines of the server log; null = not reported. */
  validationDrops: z.number().int().nullable(),
  /** Estimated cost of the run (`turn_result.costUsdTotal`); null = unknown. */
  costUsd: z.number().nullable(),
  /** Temp root of the live server (the CLI transcripts of its projects are cleaned up). */
  root: z.string().nullable(),
  /** Why the result is incomplete (report missing …); null = complete. */
  note: z.string().nullable(),
});
export type SmokeResult = z.infer<typeof smokeResultSchema>;

const annotationSchema = z.object({ type: z.string(), description: z.string().optional() });
const resultSchema = z.object({
  status: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
  annotations: z.array(annotationSchema).optional().catch(undefined),
});
const testSchema = z.object({
  status: z.string(),
  annotations: z.array(annotationSchema).catch([]),
  results: z.array(resultSchema).catch([]),
});
const specSchema = z.object({ title: z.string(), tests: z.array(testSchema).catch([]) });
interface Suite {
  title: string;
  specs: z.infer<typeof specSchema>[];
  suites?: Suite[] | undefined;
}
const suiteSchema: z.ZodType<Suite> = z.lazy(() =>
  z.object({
    title: z.string(),
    specs: z.array(specSchema).catch([]),
    suites: z.array(suiteSchema).optional(),
  }),
);
const reportSchema = z.object({
  suites: z.array(suiteSchema).catch([]),
  errors: z.array(z.object({ message: z.string().optional() })).catch([]),
  stats: z.object({
    expected: z.number().catch(0),
    unexpected: z.number().catch(0),
    flaky: z.number().catch(0),
    skipped: z.number().catch(0),
  }),
});

const liveRunSchema = z.object({ root: z.string(), costUsd: z.number() });

// eslint-disable-next-line no-control-regex -- strips ANSI colour codes from Playwright errors
const ANSI = /\u001b\[[0-9;]*m/g;

function firstLine(text: string | undefined): string {
  return (text ?? '').replace(ANSI, '').trim().split(/\r?\n/)[0]?.slice(0, 300) ?? '';
}

export type SmokeReportView = Pick<
  SmokeResult,
  'passed' | 'failed' | 'skipped' | 'flaky' | 'failures' | 'unknownCounts' | 'validationDrops'
>;

/** Counts, failures and the live annotations of a Playwright JSON report (tolerant). */
export function parsePlaywrightReport(raw: unknown): SmokeReportView {
  const report = reportSchema.parse(raw);
  const failures: SmokeResult['failures'] = report.errors.map((error) => ({
    title: '(global)',
    message: firstLine(error.message),
  }));
  let unknownCounts: Record<string, number> | null = null;
  let validationDrops: number | null = null;

  const visit = (suite: Suite, titles: string[]): void => {
    const here = suite.title === '' ? titles : [...titles, suite.title];
    for (const spec of suite.specs) {
      for (const test of spec.tests) {
        const annotations = [...test.annotations, ...test.results.flatMap((result) => result.annotations ?? [])];
        for (const annotation of annotations) {
          if (annotation.type === 'unknown-counts' && annotation.description !== undefined) {
            try {
              const counts = countsSchema.safeParse(JSON.parse(annotation.description));
              if (counts.success) unknownCounts = counts.data;
            } catch {
              // not JSON – leave unknown
            }
          } else if (annotation.type === 'validation-drops' && annotation.description !== undefined) {
            const drops = Number(annotation.description);
            if (Number.isInteger(drops) && drops >= 0) validationDrops = drops;
          }
        }
        if (test.status === 'unexpected' || test.status === 'flaky') {
          const last = test.results.at(-1);
          failures.push({
            title: [...here, spec.title].join(' › '),
            message: firstLine(last?.error?.message ?? last?.status ?? test.status),
          });
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child, here);
  };
  for (const suite of report.suites) visit(suite, []);

  return {
    passed: report.stats.expected,
    failed: report.stats.unexpected,
    skipped: report.stats.skipped,
    flaky: report.stats.flaky,
    failures,
    unknownCounts,
    validationDrops,
  };
}

/** `test-results/live-run.json` of the worker fixture, or null. */
export function parseLiveRun(raw: unknown): { root: string; costUsd: number } | null {
  const parsed = liveRunSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export interface RunSmokeOptions {
  repoRoot: string;
  /** Where Playwright writes its JSON report. */
  reportFile: string;
  /**
   * Playwright output folder (`--output`; artifacts, server-live.log, live-run.json). Own folder per
   * check: Playwright empties it at the start, so earlier reports in test-results/cli-check/ stay.
   */
  outputDir: string;
  /** Remaining budget for the smoke (USD). */
  budgetUsd: number;
  /** Hard limit for the whole run; on expiry the process tree is killed. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs `playwright test e2e/live` (list + JSON reporter) and collects the result. */
export async function runSmoke(options: RunSmokeOptions): Promise<SmokeResult> {
  const cli = createRequire(path.join(options.repoRoot, 'package.json')).resolve('@playwright/test/cli');
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    PARALLAX_LIVE: '1',
    PARALLAX_LIVE_BUDGET_USD: options.budgetUsd.toFixed(4),
    PLAYWRIGHT_JSON_OUTPUT_FILE: options.reportFile,
  };
  const child = spawnHidden(process.execPath, [cli, 'test', 'e2e/live', '--reporter=list,json', `--output=${options.outputDir}`], {
    cwd: options.repoRoot,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const run = { timedOut: false };
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      run.timedOut = true;
      if (child.pid !== undefined) killProcessTree(child.pid).catch(() => undefined);
    }, options.timeoutMs ?? 20 * 60_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const liveRun = parseLiveRun(await readJson(path.join(options.outputDir, LIVE_RUN_FILE)));
  const base: SmokeResult = {
    ran: true,
    exitCode,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    failures: [],
    unknownCounts: null,
    validationDrops: null,
    costUsd: liveRun?.costUsd ?? null,
    root: liveRun?.root ?? null,
    note: run.timedOut ? `timed out after ${String(options.timeoutMs ?? 20 * 60_000)} ms` : null,
  };
  const report = await readJson(options.reportFile);
  if (report === undefined) return { ...base, note: base.note ?? 'Playwright JSON report missing' };
  try {
    return { ...base, ...parsePlaywrightReport(report) };
  } catch (error) {
    return { ...base, note: `Playwright JSON report unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
