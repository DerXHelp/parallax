/**
 * Live smoke support (WP-22): a real Parallax server with the SdkBackend (`--backend=sdk`) against
 * the INSTALLED `claude` and the user's subscription login – only with `PARALLAX_LIVE=1`
 * (playwright.config.ts ignores e2e/live otherwise, the spec skips itself as a second guard).
 *
 * Guards (ADR-011, docs/sdk-upgrade.md): no `ANTHROPIC_API_KEY`/`_AUTH_TOKEN`/`_BASE_URL` in the
 * environment (the start fails before any spawn), `ANTHROPIC_MODEL=haiku` for every session (the
 * model picker only lists models once a process runs), after the first turn `apiKeySource` must be
 * `none` and the model Haiku (`assertSubscriptionHaiku`), and a cost budget over all turns
 * (`assertBudget`, default 0.50 USD, `PARALLAX_LIVE_BUDGET_USD`).
 *
 * The server runs on a temp PARALLAX_HOME and port 0, validates outgoing values with `log`
 * (contract slips of real SDK data become error lines – `assertCleanExit` fails on them) and is
 * adopted as an `E2eServer` (lock file + health), so the normal page objects and the clean-exit
 * check (exit, lock file gone, no child process left, no error line) apply unchanged.
 */
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { buildEnv, clientAppId } from '../../../src/server/claude/env';
import { killProcessTree, runFile, spawnHidden } from '../../../src/server/lib/process';
import { REPO_ROOT, SERVER_BUNDLE } from '../../support/paths';
import { adoptE2eServer, type E2eServer } from '../../support/server';

/** Environment switch of every live run (also the recorder's, ADR-011). */
export const LIVE = process.env.PARALLAX_LIVE === '1';

/** Variables that would bill the API instead of the subscription – a live run refuses them. */
const API_BILLING_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

const DEFAULT_BUDGET_USD = 0.5;

export interface LiveServer {
  server: E2eServer;
  /** Temp folder with `home/` and the project folders. */
  root: string;
  /** stdout + stderr of the server process. */
  output(): string;
}

/** Env of the live server: no `PARALLAX_*`, Vitest or NODE_ENV of the caller; Haiku for the CLI. */
export function liveServerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const billing = API_BILLING_VARS.filter((name) => (base[name] ?? '') !== '');
  if (billing.length > 0) {
    throw new Error(`live smoke refused: ${billing.join(', ')} set (subscription login only, ADR-011)`);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('PARALLAX_') || key === 'VITEST' || key.startsWith('VITEST_') || key === 'NODE_ENV')
      continue;
    env[key] = value;
  }
  env.ANTHROPIC_MODEL = 'haiku';
  return env;
}

/** Starts `dist/server.js --backend=sdk` on a temp home and waits until it is ready. */
export async function startLiveServer(): Promise<LiveServer> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parallax-live-e2e-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  const startedAt = new Date(Date.now() - 1000);
  let out = '';
  const child = spawnHidden(
    process.execPath,
    // --toasts=off: the smoke must not pop up Windows toasts (NODE_ENV is not "test" here).
    [SERVER_BUNDLE, '--backend=sdk', '--port=0', `--home=${home}`, '--validate=log', '--toasts=off'],
    {
      cwd: REPO_ROOT,
      env: liveServerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      onStderr: (chunk) => {
        out += chunk;
      },
    },
  );
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    out += chunk;
  });
  const early = new Promise<never>((_, reject) => {
    child.once('exit', (code) => {
      reject(new Error(`live server exited with ${String(code)} before it was ready:\n${out}`));
    });
  });
  try {
    const server = await Promise.race([adoptE2eServer({ root, home, startedAt }), early]);
    return { server, root, output: () => out };
  } catch (error) {
    if (child.pid !== undefined && child.exitCode === null) await killProcessTree(child.pid);
    throw error;
  }
}

const storedEntriesSchema = z.object({
  entries: z.array(
    z.looseObject({
      id: z.string(),
      apiKeySource: z.string().nullable(),
      lastModel: z.string().nullable(),
      cliVersion: z.string().nullable(),
    }),
  ),
});

/** The persisted entry (`sessions.json`), or null while it is not written yet. */
export async function storedEntry(
  home: string,
  entryId: string,
): Promise<z.infer<typeof storedEntriesSchema>['entries'][number] | null> {
  try {
    const parsed = storedEntriesSchema.safeParse(
      JSON.parse(await readFile(path.join(home, 'sessions.json'), 'utf8')),
    );
    return parsed.success ? (parsed.data.entries.find((e) => e.id === entryId) ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * After the first turn: the CLI ran with the subscription login (`apiKeySource: none`) on Haiku.
 * Anything else stops the live run (serial mode skips the remaining tests).
 */
export async function assertSubscriptionHaiku(
  home: string,
  entryId: string,
): Promise<{ cliVersion: string | null }> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const entry = await storedEntry(home, entryId);
    const apiKeySource = entry?.apiKeySource ?? null;
    const model = entry?.lastModel ?? null;
    if (apiKeySource !== null && model !== null) {
      if (apiKeySource !== 'none') {
        throw new Error(`STOP: apiKeySource is "${apiKeySource}" – only the subscription login is allowed`);
      }
      if (!/haiku/i.test(model)) throw new Error(`STOP: the session ran on ${model}, not Haiku`);
      return { cliVersion: entry?.cliVersion ?? null };
    }
    if (Date.now() > deadline) throw new Error('apiKeySource/model not persisted 15 s after the first turn');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const turnResultLineSchema = z.object({
  item: z.looseObject({
    id: z.string(),
    kind: z.literal('turn_result'),
    costUsdTotal: z.number().nullable(),
  }),
});

/**
 * Estimated cost of all turns of this server (`turn_result.costUsdTotal` from the transcript logs:
 * cumulative per claude process – a drop starts a new segment, e.g. after a resume or /clear).
 */
export async function liveCostUsd(home: string): Promise<number> {
  const entriesDir = path.join(home, 'entries');
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(entriesDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    for (const name of await readdir(path.join(entriesDir, entry))) {
      if (!name.endsWith('.transcript.jsonl')) continue;
      const seen = new Set<string>();
      let last = 0;
      let segment = 0;
      for (const line of (await readFile(path.join(entriesDir, entry, name), 'utf8')).split(/\r?\n/)) {
        if (!line.includes('"turn_result"')) continue;
        const parsed = turnResultLineSchema.safeParse(JSON.parse(line));
        if (!parsed.success || seen.has(parsed.data.item.id)) continue;
        seen.add(parsed.data.item.id);
        const cost = parsed.data.item.costUsdTotal;
        if (cost === null) continue;
        if (cost < last) {
          total += segment;
          segment = 0;
        }
        segment = Math.max(segment, cost);
        last = cost;
      }
      total += segment;
    }
  }
  return total;
}

/** Stops the live run before a new prompt when the estimated cost exceeds the budget. */
export async function assertBudget(home: string): Promise<number> {
  const raw = Number(process.env.PARALLAX_LIVE_BUDGET_USD ?? DEFAULT_BUDGET_USD);
  const budget = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_USD;
  const spent = await liveCostUsd(home);
  if (spent > budget)
    throw new Error(`STOP: live budget exceeded (${spent.toFixed(4)} > ${String(budget)} USD)`);
  return spent;
}

/** Server log lines of the validation (`--validate=log`): contract slips of real SDK data. */
export async function validationDrops(server: E2eServer): Promise<string[]> {
  return (await server.logLines()).filter((line) =>
    /invalid (outgoing value|transcript line) dropped/.test(line),
  );
}

const countsSchema = z.record(z.string(), z.number());

/**
 * Merges every `unknownCounts` object of a server frame (session detail of the normalizer, e.g. in
 * `session.snapshot`/`detail.patch`) into `into` (maximum per key – the counts are cumulative).
 */
export function collectUnknownCounts(payload: string | Buffer, into: Record<string, number>): void {
  const text = typeof payload === 'string' ? payload : payload.toString('utf8');
  if (!text.includes('"unknownCounts"')) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      const counts = key === 'unknownCounts' ? countsSchema.safeParse(child) : null;
      if (counts?.success === true) {
        for (const [name, count] of Object.entries(counts.data))
          into[name] = Math.max(into[name] ?? 0, count);
      } else {
        visit(child);
      }
    }
  };
  visit(parsed);
}

/** `claude --version` of the binary the UI shows (env without the caller's session markers, C.2). */
export async function claudeVersion(executable: string, cwd: string): Promise<string> {
  const env = buildEnv({
    base: process.env,
    profile: { env: {}, configDir: null },
    entryId: null,
    clientApp: clientAppId('e2e-live'),
  });
  const result = await runFile(executable, ['--version'], { cwd, env, timeoutMs: 60_000 });
  const match = /(\d+\.\d+\.\d+)/.exec(result.stdout);
  if (result.exitCode !== 0 || match?.[1] === undefined) {
    throw new Error(`claude --version failed (${String(result.exitCode)}): ${result.stderr}`);
  }
  return match[1];
}
