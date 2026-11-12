/**
 * `pnpm cli-check` – short check after a `claude` update (WP-62, docs/sdk-upgrade.md "Stufe 1",
 * skill `/claude-update`). Live with Haiku and the subscription login, at most 0.05 USD per check
 * (standing user permission 12.11.2026).
 *
 *   pnpm cli-check                  pre-check, probe, live smoke, comparison, report, cleanup
 *   pnpm cli-check --accept         the same; afterwards the observation becomes the profile
 *   pnpm cli-check --last           no live call: compare the last run again (e.g. other profile)
 *   pnpm cli-check --last --accept  no live call: accept the last run as the profile
 *   --profile=<file>                compare with (and accept into) another profile file
 *
 * Steps: 1. pre-check without cost (`claude --version`, auth = claude.ai/firstParty, no API-key
 * variables, C.7); 2. probe (scripts/cli-check/probe.ts, one Haiku turn; WP-64: Remote Control on,
 * `bridge_state connected`, off – scripts/cli-check/remoteControl.ts; WP-65: one session title, the
 * usage query, `backgroundTasks` present – scripts/cli-check/overview.ts); 3. live smoke `e2e/live`
 * with the remaining budget; 4. comparison with the profile (compare.ts); 5. report under
 * test-results/cli-check/ + console summary; 6. budget guard (probe + smoke ≤ 0.05 USD); 7. cleanup
 * of own data outside the repo (cleanup.ts). Exit: 0 = green, 1 = deviations, 2 = error/abort;
 * with `--accept` 0 once the profile is written (the deviations are accepted on purpose).
 * Heavy run (Playwright): below-normal priority, never parallel to another heavy run (ADR-154).
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { lowerProcessPriority } from '../repo.config.ts';
import { CLI_PROFILE_PATH, parseCliProfile, type CliProfile } from '../src/server/claude/cliProfile';
import { createClaudeIntegration } from '../src/server/claude/integration';
import { readSdkManifest } from '../src/server/claude/resolveClaude';
import { writeFileAtomic } from '../src/server/lib/fs';
import { newId } from '../src/server/lib/ids';
import { getEnvVar } from '../src/server/lib/windows';
import { cleanupOwnData } from './cli-check/cleanup';
import { profileFromObservation, profileJson } from './cli-check/observation';
import { precheckProblems } from './cli-check/precheck';
import { ProbeStop, runProbe, type ProbeTrace } from './cli-check/probe';
import {
  CHECK_BUDGET_USD,
  appendProtocol,
  evaluate,
  formatReport,
  formatSummary,
  protocolRow,
  runRecordSchema,
  type RunRecord,
} from './cli-check/report';
import { runSmoke } from './cli-check/smoke';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(REPO_ROOT, 'test-results', 'cli-check');
const LAST_RUN_FILE = path.join(RESULTS_DIR, 'last-run.json');
const PROTOCOL_FILE = path.join(REPO_ROOT, 'docs', 'cli-updates.md');

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const argsSchema = z.object({
  accept: z.boolean(),
  last: z.boolean(),
  help: z.boolean(),
  profile: z.string().min(1).nullable(),
});
type Args = z.infer<typeof argsSchema>;

function parseArgs(argv: readonly string[]): Args {
  const flags = argv.filter((arg) => arg !== '--');
  const unknown = flags.filter(
    (arg) => !['--accept', '--last', '--help', '-h'].includes(arg) && !arg.startsWith('--profile='),
  );
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(' ')} (see --help)`);
  const profile = flags.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length) ?? null;
  return argsSchema.parse({
    accept: flags.includes('--accept'),
    last: flags.includes('--last'),
    help: flags.includes('--help') || flags.includes('-h'),
    profile: profile === null ? null : path.resolve(profile),
  });
}

function usage(): void {
  out('usage: pnpm cli-check [--accept] [--last] [--profile=<file>]');
  out('  (no flag)       live check: pre-check, probe (Haiku), e2e/live, comparison, report, cleanup');
  out('  --accept        write the observed profile (and a line in docs/cli-updates.md) unless the run failed');
  out('  --last          no live call: compare the last run (test-results/cli-check/last-run.json) again');
  out(`  --profile=<f>   use another profile file instead of ${CLI_PROFILE_PATH}`);
  out('exit: 0 = green (with --accept: profile written), 1 = deviations, 2 = error/abort');
}

async function readProfile(file: string): Promise<CliProfile | null> {
  try {
    return parseCliProfile(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return null;
  }
}

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Parallax version (package.json) for the client app id of the probe (CLAUDE_AGENT_SDK_CLIENT_APP). */
async function appVersion(): Promise<string> {
  const text = await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8');
  return z.looseObject({ version: z.string().min(1) }).parse(JSON.parse(text)).version;
}

/** The full live run (steps 1–3, 6, 7); never throws – a stop lands in `record.error`. */
async function liveRun(started: Date): Promise<RunRecord> {
  const record: RunRecord = {
    version: 1,
    startedAt: started.toISOString(),
    finishedAt: started.toISOString(),
    claudePath: null,
    cliVersion: null,
    sdkVersion: null,
    sdkClaudeCodeVersion: null,
    auth: { method: null, apiProvider: null, subscriptionType: null },
    observation: null,
    probe: null,
    smoke: null,
    cost: { probeUsd: 0, smokeUsd: 0, totalUsd: 0, budgetUsd: CHECK_BUDGET_USD },
    cleanup: null,
    error: null,
  };

  // 1. Pre-check without cost.
  const sdk = await readSdkManifest();
  record.sdkVersion = sdk?.sdkVersion ?? null;
  record.sdkClaudeCodeVersion = sdk?.claudeCodeVersion ?? null;
  const integration = createClaudeIntegration({
    appVersion: await appVersion(),
    sdkClaudeCodeVersion: sdk?.claudeCodeVersion ?? null,
  });
  const status = await integration.checkProfile(STANDARD_PROFILE_ID);
  record.claudePath = status.path;
  record.cliVersion = status.version;
  record.auth = {
    method: status.auth.method,
    apiProvider: status.auth.apiProvider,
    subscriptionType: status.auth.subscriptionType,
  };
  out(
    `cli-check: claude ${status.version ?? '?'} (tested ${status.testedVersion ?? 'none'}), SDK ${record.sdkVersion ?? '?'} ` +
      `(expects >= ${record.sdkClaudeCodeVersion ?? '?'}), login ${status.auth.method ?? '?'}/${status.auth.apiProvider ?? '?'}`,
  );
  const problems = precheckProblems({ env: process.env, status, sdkVersion: record.sdkVersion });
  if (problems.length > 0 || sdk === null) {
    record.error = `pre-check failed (no live call): ${problems.join('; ')}`;
    return record;
  }

  // 2. Probe in an own scratch folder with an own temp home.
  const scratch = await mkdtemp(path.join(os.tmpdir(), `parallax-cli-check-${stamp(started)}-`));
  const work = path.join(scratch, 'work');
  const home = path.join(scratch, 'home');
  await mkdir(work, { recursive: true });
  await mkdir(home, { recursive: true });
  process.env.PARALLAX_HOME = home;
  const trace: ProbeTrace = { sessionIds: new Set(), costUsd: 0 };
  const entryId = newId('en');
  const launch = await integration.launchSpecFor(STANDARD_PROFILE_ID, entryId);
  const configDirEnv = getEnvVar(launch.env, 'CLAUDE_CONFIG_DIR');
  const configDir = configDirEnv ?? path.join(os.homedir(), '.claude');
  const claudeJson =
    configDirEnv === undefined ? path.join(os.homedir(), '.claude.json') : path.join(configDirEnv, '.claude.json');
  const roots = [scratch];
  try {
    out(`cli-check: probe in ${work}`);
    const probe = await runProbe(
      {
        launch,
        cwd: work,
        entryId,
        sdkVersion: sdk.sdkVersion,
        budgetUsd: CHECK_BUDGET_USD,
        log: out,
      },
      trace,
    );
    record.observation = probe.observation;
    record.probe = {
      costUsd: probe.costUsd,
      sessionIds: probe.sessionIds,
      apiKeySource: probe.apiKeySource,
      resultSubtype: probe.resultSubtype,
      messageTypes: probe.messageTypes,
      contextDetail: probe.contextDetail,
      durationMs: probe.durationMs,
      remoteControl: probe.remoteControl,
      overview: probe.overview,
    };
    record.cost.probeUsd = probe.costUsd;
    out(`cli-check: probe done – ${probe.costUsd.toFixed(4)} USD, ${String(probe.observation.tools.length)} tools`);

    // 3. Live smoke with the rest of the budget (6. the smoke checks it before every prompt).
    const remaining = CHECK_BUDGET_USD - probe.costUsd;
    if (remaining <= 0) throw new ProbeStop('budget', `the probe used the whole budget (${probe.costUsd.toFixed(4)} USD)`);
    out(`cli-check: live smoke e2e/live (budget ${remaining.toFixed(4)} USD) …`);
    const smoke = await runSmoke({
      repoRoot: REPO_ROOT,
      reportFile: path.join(RESULTS_DIR, `${stamp(started)}-smoke.json`),
      outputDir: path.join(RESULTS_DIR, `${stamp(started)}-smoke`),
      budgetUsd: remaining,
    });
    record.smoke = smoke;
    if (smoke.root !== null) roots.push(smoke.root);
    record.cost.smokeUsd = smoke.costUsd ?? 0;
  } catch (error) {
    record.cost.probeUsd = Math.max(record.cost.probeUsd, trace.costUsd);
    record.error =
      error instanceof ProbeStop
        ? `probe stopped (${error.kind}): ${error.message}${error.kind === 'auth' ? ' – do not retry before the user decided' : ''}`
        : `check failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    // 7. Cleanup of own data outside the repo.
    record.cleanup = await cleanupOwnData({
      roots,
      deleteRoots: [scratch],
      sessionIds: [...trace.sessionIds],
      configDir,
      claudeJson,
      tempDir: os.tmpdir(),
      since: started,
    });
  }
  record.cost.totalUsd = record.cost.probeUsd + record.cost.smokeUsd;
  if (record.error === null && record.cost.totalUsd > CHECK_BUDGET_USD) {
    record.error = `budget exceeded: ${record.cost.totalUsd.toFixed(4)} USD > ${CHECK_BUDGET_USD.toFixed(2)} USD`;
  }
  return record;
}

async function loadLastRun(): Promise<RunRecord | null> {
  try {
    const parsed = runRecordSchema.safeParse(JSON.parse(await readFile(LAST_RUN_FILE, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  // ADR-154: the check (Playwright, Chrome, server, claude) never stalls the desktop.
  lowerProcessPriority();
  const profilePath = args.profile ?? path.join(REPO_ROOT, CLI_PROFILE_PATH);
  const profile = await readProfile(profilePath);
  const started = new Date();

  let record: RunRecord;
  if (args.last) {
    const last = await loadLastRun();
    if (last === null) {
      err(`cli-check: no readable last run (${LAST_RUN_FILE}) – run \`pnpm cli-check\` first.`);
      return 2;
    }
    record = last;
  } else {
    record = await liveRun(started);
    record.finishedAt = new Date().toISOString();
  }

  const evaluation = evaluate(record, profile);
  const reportName = `${stamp(args.last ? new Date() : started)}${args.last ? '-last' : ''}.md`;
  const reportPath = path.join(RESULTS_DIR, reportName);
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    reportPath,
    formatReport({ record, profile, profilePath, evaluation, mode: args.last ? 'last' : 'live' }),
  );
  if (!args.last) await writeFile(LAST_RUN_FILE, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(formatSummary(evaluation, record, reportPath));

  if (args.accept) {
    if (evaluation.exitCode === 2 || record.observation === null) {
      err('cli-check: --accept refused – the run did not finish (exit 2).');
      return 2;
    }
    const next = profileFromObservation(record.observation, new Date(record.finishedAt));
    await writeFileAtomic(profilePath, profileJson(next));
    out(`cli-check: profile written: ${profilePath} (claude ${next.cliVersion})`);
    if (args.profile === null) {
      const existing = await readFile(PROTOCOL_FILE, 'utf8').catch(() => null);
      const row = protocolRow({ date: new Date(record.finishedAt), previous: profile?.cliVersion ?? null, record, evaluation });
      await writeFileAtomic(PROTOCOL_FILE, appendProtocol(existing, row));
      out(`cli-check: protocol line added: ${path.relative(REPO_ROOT, PROTOCOL_FILE)}`);
    }
    // The deviations are accepted on purpose: the profile now matches the CLI (exit 0).
    return 0;
  }
  return evaluation.exitCode;
}

// process.exit: the SDK may keep handles open after the probe (like scripts/record.ts).
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    err(`cli-check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  },
);
