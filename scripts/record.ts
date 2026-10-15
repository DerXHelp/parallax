/**
 * `pnpm record <scenario…|all>` – SDK fixture recorder (WP-01).
 *
 * Runs scripted scenarios against the installed `claude` (Haiku, mini prompts, scratch folder
 * under %TEMP%\parallax-spike-<stamp>\work, subscription login) and writes sanitized message
 * streams to test/fixtures/sdk/<scenario>.jsonl. Raw recordings go to .recordings/ (git-ignored).
 * Recordings from the work machine never enter the repo.
 *
 *   pnpm record --list            list scenarios (no live call)
 *   pnpm record --stats           summarize fixtures and spike usage (no live call)
 *   pnpm record --resanitize [sz] rebuild fixtures from .recordings raw files (no session)
 *   PARALLAX_LIVE=1 pnpm record auth-probe
 *   PARALLAX_LIVE=1 pnpm record all
 *
 * Guards: refuses without PARALLAX_LIVE=1; requires `claude auth status` = claude.ai login;
 * every scenario after a failed auth probe is refused; stops on an API key in use, auth/credit
 * errors or when the estimated spend of all spike runs exceeds the budget (2 USD).
 */
import { parseAuthStatus } from '../src/server/claude/authStatus';
import { BUDGET_USD, createRunContext, loadState, saveState, STATE_FILE } from './record/context';
import { resanitize } from './record/resanitize';
import { printStats } from './record/stats';
import { FatalError, describeError } from './record/session';
import { SCENARIOS, findScenario } from './record/scenarios';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

function usage(): void {
  out('usage: pnpm record <scenario…|all> | --list | --stats | --resanitize [scenario…]');
  out('scenarios (in "all" order):');
  for (const scenario of SCENARIOS) {
    out(`  ${scenario.name.padEnd(20)} ${scenario.live ? 'live ' : 'local'} ${scenario.description}`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = argv.filter((arg) => arg !== '--');
  if (args.length === 0 || args.includes('--help')) {
    usage();
    return args.length === 0 ? 1 : 0;
  }
  if (args.includes('--list')) {
    usage();
    return 0;
  }
  if (args.includes('--stats')) {
    printStats();
    return 0;
  }
  if (args.includes('--resanitize')) {
    return resanitize(args.filter((arg) => !arg.startsWith('--')));
  }

  if (process.env.PARALLAX_LIVE !== '1') {
    err('record: refusing to start a live `claude` without PARALLAX_LIVE=1 (WP permission required).');
    return 2;
  }

  const names = args
    .filter((arg) => !arg.startsWith('--'))
    .flatMap((arg) => (arg === 'all' ? SCENARIOS.map((scenario) => scenario.name) : [arg]));
  const unknown = names.filter((name) => findScenario(name) === undefined);
  if (unknown.length > 0) {
    err(`record: unknown scenario(s): ${unknown.join(', ')} (see --list)`);
    return 2;
  }

  const stored = loadState();
  if (stored.blocked !== undefined) {
    if (!args.includes('--unblock')) {
      err(`record: blocked since ${stored.blocked.at}: ${stored.blocked.reason}`);
      err(`        (state: ${STATE_FILE}; only clear with --unblock after the user decided)`);
      return 3;
    }
    delete stored.blocked;
    saveState(stored);
  }

  const ctx = await createRunContext();
  out(`record: claude ${ctx.cliVersion}, SDK ${ctx.sdkVersion}, scratch ${ctx.scratchRoot}`);
  out(`record: spent so far ${ctx.spentUsd().toFixed(4)} USD of ${BUDGET_USD} USD`);
  const auth = parseAuthStatus(ctx.authStatus);
  if (auth.state !== 'logged_in' || auth.method !== 'claude.ai' || auth.apiProvider !== 'firstParty') {
    ctx.state.blocked = {
      reason: `claude auth status: state=${auth.state}, authMethod=${auth.method ?? '-'}, apiProvider=${auth.apiProvider ?? '-'}`,
      at: new Date().toISOString(),
    };
    ctx.save();
    err(`record: BLOCKED – ${ctx.state.blocked.reason}`);
    return 3;
  }

  let exitCode = 0;
  for (const name of names) {
    const scenario = findScenario(name);
    if (scenario === undefined) continue;
    if (scenario.live && name !== 'auth-probe' && !ctx.state.authProbeOk) {
      err(`record: ${name} refused – run "auth-probe" successfully first.`);
      return 3;
    }
    if (scenario.live && ctx.spentUsd() >= ctx.budgetUsd) {
      err(`record: budget exhausted (${ctx.spentUsd().toFixed(4)} USD) – ${name} not started.`);
      return 4;
    }
    try {
      await scenario.run(ctx);
    } catch (error) {
      if (error instanceof FatalError) {
        if (error.kind !== 'budget') {
          ctx.state.blocked = { reason: `${name}: ${error.message}`, at: new Date().toISOString() };
          ctx.save();
        }
        err(`record: STOPPED (${error.kind}) – ${error.message}`);
        return error.kind === 'budget' ? 4 : 3;
      }
      err(`record: scenario ${name} failed: ${describeError(error).message}`);
      exitCode = 1;
    }
  }
  out(`record: done, spent ${ctx.spentUsd().toFixed(4)} USD in total (state: ${STATE_FILE})`);
  return exitCode;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    err(`record: ${describeError(error).message}`);
    process.exit(1);
  },
);
