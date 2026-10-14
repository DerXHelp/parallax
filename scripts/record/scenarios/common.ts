/** Scenario framework of the recorder: one fixture per scenario, usually one live session. */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { FIXTURES_DIR, type RunContext, type SessionRecord } from '../context';
import { FatalError, LiveSession, addUsage, describeError, type LiveSessionConfig } from '../session';
import { FixtureRecorder } from '../writer';

export interface Scenario {
  name: string;
  description: string;
  /** Starts a live `claude` (token use). `history` only reads transcripts. */
  live: boolean;
  run(ctx: RunContext): Promise<void>;
}

export function newRecorder(ctx: RunContext, scenario: string, description: string): FixtureRecorder {
  return new FixtureRecorder(scenario, {
    description,
    sdkVersion: ctx.sdkVersion,
    cliVersion: ctx.cliVersion,
  });
}

export function writeFixture(ctx: RunContext, rec: FixtureRecorder): string {
  const file = rec.write({ fixturesDir: FIXTURES_DIR, recordingsDir: ctx.recordingsDir }, ctx.sanitizer());
  process.stdout.write(`  fixture: ${path.relative(process.cwd(), file)} (${rec.size} events)\n`);
  return file;
}

/** Running cost of sessions that are still open (keyed per session) for the budget guard. */
const openCosts = new Map<object, number>();

export interface SessionSetup extends Omit<LiveSessionConfig, 'cwd'> {
  cwd?: string;
  lowerDrive?: boolean;
  closeMode?: 'close' | 'eof';
  /** For resume: cost/usage already contained in the resumed transcript (subtracted once). */
  baseline?: Pick<SessionRecord, 'costUsd' | 'modelUsage'>;
}

/**
 * Runs `body` against one live session, closes it (process-tree check), stores the session in
 * the spike state and writes the fixture – also when `body` fails. FatalError is re-thrown.
 */
export async function withSession(
  ctx: RunContext,
  scenario: string,
  description: string,
  setup: SessionSetup,
  body: (session: LiveSession, rec: FixtureRecorder) => Promise<void>,
): Promise<LiveSession> {
  const rec = newRecorder(ctx, scenario, description);
  const cwd = setup.cwd ?? ctx.scenarioCwd(scenario, { lowerDrive: setup.lowerDrive === true });
  const spentBefore = ctx.spentUsd();
  const costKey = {};
  const environment = {
    claudePath: ctx.claudePath,
    env: ctx.envInfo.env,
    envSummary: {
      set: ctx.envInfo.set,
      removed: ctx.envInfo.removed,
      pathEntriesRemoved: ctx.envInfo.pathEntriesRemoved,
    },
    onCost: (sessionCost: number): boolean => {
      openCosts.set(costKey, sessionCost);
      const open = [...openCosts.values()].reduce((sum, value) => sum + value, 0);
      return spentBefore + open > ctx.budgetUsd;
    },
  };
  const session = new LiveSession(environment, rec, { ...setup, cwd });
  const started = new Date().toISOString();
  const t0 = performance.now();
  let failure: unknown;
  process.stdout.write(`> ${scenario}: cwd ${cwd}\n`);
  try {
    session.start();
    await body(session, rec);
  } catch (error) {
    failure = error;
    rec.record('error', { where: 'scenario', ...describeError(error) });
  } finally {
    try {
      await session.close(setup.closeMode ?? 'close');
    } catch (error) {
      rec.record('error', { where: 'close', ...describeError(error) });
    }
    openCosts.delete(costKey);
  }

  const rawCost = session.usage.costUsd;
  let costUsd = rawCost;
  let modelUsage = session.usage.modelUsage;
  const baseline = setup.baseline;
  if (baseline !== undefined && (session.usage.firstCost ?? 0) + 1e-9 >= baseline.costUsd) {
    costUsd = Math.max(0, rawCost - baseline.costUsd);
    modelUsage = addUsage(modelUsage, baseline.modelUsage, -1);
  }
  const record: SessionRecord = {
    scenario,
    stamp: ctx.stamp,
    cwd,
    sessionIds: [...session.sessionIds],
    startedAt: started,
    costUsd,
    rawCostUsd: rawCost,
    modelUsage,
    results: session.usage.results,
    numTurns: session.usage.numTurns,
    assistantMessageIds: session.assistantMessageIds.size,
    pid: session.pid ?? null,
    exitMsSinceClose: session.exitMsSinceClose,
    orphans: session.orphans,
    permissionModes: session.permissionModes,
    ok: failure === undefined,
    ...(failure === undefined ? {} : { error: describeError(failure).message }),
  };
  ctx.state.sessions.push(record);
  ctx.save();

  try {
    writeFixture(ctx, rec);
  } catch (error) {
    process.stdout.write(`  fixture NOT written: ${describeError(error).message}\n`);
    failure ??= error;
  }
  process.stdout.write(
    `  ${failure === undefined ? 'ok' : 'FAILED'} in ${Math.round((performance.now() - t0) / 1000)} s, ` +
      `${costUsd.toFixed(4)} USD (total ${ctx.spentUsd().toFixed(4)} USD), session ${session.sessionId ?? '-'}\n`,
  );
  if (failure instanceof FatalError) throw failure;
  if (failure !== undefined)
    throw failure instanceof Error ? failure : new Error(describeError(failure).message);
  return session;
}

/** Text of the first text content block of a canUseTool input field, for prompts that echo it. */
export function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}
