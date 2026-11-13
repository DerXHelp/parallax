/**
 * Step 2c of `pnpm cli-check` (WP-65 §1.7): the SDK parts of the session overview in the probe
 * session – after the turn and the Remote Control step:
 * - `generateSessionTitle(<short description>, { persist: false })`: one small model request (Haiku
 *   side query, costs a fraction of a cent), the answer checked like the server does (`titleOf`);
 * - the experimental usage query `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
 *   skipBehaviors: true })` (no model request): the answer must carry a `rate_limits` object with
 *   `utilization`/`resets_at` windows (`usageLimitsOf`);
 * - `backgroundTasks`: only whether the method exists – never called (the probe runs no tool).
 * The results go into the profile (`sessionTitle`, `usageQuery`, `backgroundTasks`, observation.ts);
 * a change against the profile is a finding (compare.ts). A failure here never stops the check.
 */
import { z } from 'zod';
import { titleOf, usageAnswerSchema, usageLimitsOf } from '../../src/server/backend/overview';
import { withTimeout } from '../../src/server/backend/sdkBackend';

/** The description of the title request (no account data, no prompt of the user). */
export const TITLE_PROBE_DESCRIPTION = 'Check that the installed Claude Code CLI answers a short test prompt with OK.';

/** The probe's Query: the three methods (internal or experimental – checked at runtime). */
export interface OverviewProbeHandle {
  generateSessionTitle?(description: string, opts?: { persist?: boolean }): Promise<unknown>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
  backgroundTasks?(toolUseId?: string): Promise<unknown>;
}

const checkSchema = z.object({
  available: z.boolean(),
  /** Why not (English, for the report); null when available. */
  detail: z.string().nullable(),
});

export const overviewProbeResultSchema = z.object({
  sessionTitle: checkSchema.extend({
    /** The title the CLI generated (for the report; the probe description holds no user data). */
    title: z.string().nullable(),
  }),
  usage: checkSchema.extend({
    /** Windows with a value (`five_hour`, `seven_day` …), sorted. */
    windows: z.array(z.string()),
  }),
  backgroundTasks: z.boolean(),
});
export type OverviewProbeResult = z.infer<typeof overviewProbeResultSchema>;

export interface OverviewProbeOptions {
  controlMs: number;
  log?: (line: string) => void;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

async function probeTitle(handle: OverviewProbeHandle, controlMs: number): Promise<OverviewProbeResult['sessionTitle']> {
  if (typeof handle.generateSessionTitle !== 'function') {
    return { available: false, detail: 'Query.generateSessionTitle is missing (SDK)', title: null };
  }
  try {
    const raw = await withTimeout(
      handle.generateSessionTitle(TITLE_PROBE_DESCRIPTION, { persist: false }),
      controlMs,
      'generateSessionTitle',
    );
    const title = titleOf(raw);
    return title === null
      ? { available: false, detail: 'the answer of generateSessionTitle is no title string', title: null }
      : { available: true, detail: null, title };
  } catch (error) {
    return { available: false, detail: `generateSessionTitle failed: ${message(error)}`, title: null };
  }
}

async function probeUsage(handle: OverviewProbeHandle, controlMs: number): Promise<OverviewProbeResult['usage']> {
  if (typeof handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') {
    return { available: false, detail: 'the usage query of the Query is missing (SDK)', windows: [] };
  }
  try {
    const raw = await withTimeout(
      handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      controlMs,
      'usage query',
    );
    const limits = usageLimitsOf(raw);
    if (limits === null) {
      const head = usageAnswerSchema.safeParse(raw);
      const detail =
        head.success && head.data.rate_limits_available === false
          ? 'rate_limits_available is false (no plan limits for this login)'
          : 'the answer has no rate_limits object (expected windows with utilization/resets_at)';
      return { available: false, detail, windows: [] };
    }
    const windows = Object.keys(limits.windows).sort();
    return windows.length === 0
      ? { available: false, detail: 'rate_limits has no window with utilization/resets_at', windows }
      : { available: true, detail: null, windows };
  } catch (error) {
    return { available: false, detail: `usage query failed: ${message(error)}`, windows: [] };
  }
}

/** Runs step 2c against the probe's Query (pure apart from the handle; tested with a fake handle). */
export async function probeOverview(handle: OverviewProbeHandle, o: OverviewProbeOptions): Promise<OverviewProbeResult> {
  const log = o.log ?? (() => undefined);
  const sessionTitle = await probeTitle(handle, o.controlMs);
  const usage = await probeUsage(handle, o.controlMs);
  const backgroundTasks = typeof handle.backgroundTasks === 'function';
  log(
    `cli-check: overview – title ${sessionTitle.available ? 'ok' : `NOT ok (${sessionTitle.detail ?? '?'})`}, ` +
      `usage ${usage.available ? `ok (${usage.windows.join(', ')})` : `NOT ok (${usage.detail ?? '?'})`}, ` +
      `backgroundTasks ${backgroundTasks ? 'present' : 'MISSING'}`,
  );
  return { sessionTitle, usage, backgroundTasks };
}

/** Bridge summaries the probe saw (counted only when Remote Control ran; informational). */
export function bridgeSummaryCounts(messageTypes: Readonly<Record<string, number>>): {
  taskSummary: number;
  postTurnSummary: number;
} {
  return {
    taskSummary: messageTypes['system/task_summary'] ?? 0,
    postTurnSummary: messageTypes['system/post_turn_summary'] ?? 0,
  };
}
