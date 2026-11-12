import type { DecisionId, PermissionMode } from '@shared/common';
import type { Decision, DecisionOutcome, PlanDecision, PlanVersionInfo } from '@shared/model';
import type { TranslationKey, TranslationParams } from '@web/i18n';

/**
 * Plan versions of an entry for the plan panel (ADR-148): the stored versions (`plan.list`) merged
 * with what the client already knows – open/expired plan decisions of the view (text without
 * `plan.read`, also before the next `plan.list` answer) and outcomes from the transcript
 * (`tool_call.decision.outcome`, fresher than the last list). Plus the rule which version the panel
 * shows when the user did not pick one. Pure.
 */

/**
 * `open`/`waiting` = the decision is still in the view (open, or expired after a restart and still
 * answerable with "Continue & implement"); the others come from the outcome (`expired` = closed
 * after a restart, `closed` = resolved without a known outcome).
 */
export type PlanVersionStatus =
  | { kind: 'open' }
  | { kind: 'waiting' }
  | { kind: 'revised' }
  | { kind: 'approved'; mode: PermissionMode; fresh: boolean }
  | { kind: 'cancelled' }
  | { kind: 'expired' }
  | { kind: 'closed' };

/** The decision of the version can still be answered (open or expired card in the bar). */
export function isPendingStatus(status: PlanVersionStatus): boolean {
  return status.kind === 'open' || status.kind === 'waiting';
}

export interface PlanVersionEntry {
  version: number;
  decisionId: DecisionId;
  /** ISO time the version was created (null when known only from a copy). */
  createdAt: string | null;
  planFilePath: string | null;
  /** `plans/v<N>.md` exists – false: `plan.read` answers PLAN_NOT_FOUND. */
  stored: boolean;
  status: PlanVersionStatus;
  /** The plan text when the client has it (open/expired decision, the panel's copy). */
  knownText: string | null;
  /** v(n−1) of the same conversation when the decision carries it (`previousVersionPlan`). */
  knownPreviousText: string | null;
}

/** The plan the panel keeps a copy of (bar-store `PlanPanelState`, set by "Open plan"). */
export interface PlanCopy {
  decisionId: DecisionId;
  version: number;
  plan: string;
  planFilePath: string | null;
}

/** Status of a resolved plan decision from its outcome (null = no outcome known). */
export function planStatusOf(outcome: DecisionOutcome | null): PlanVersionStatus {
  switch (outcome?.type) {
    case 'plan_approved':
      return { kind: 'approved', mode: outcome.mode, fresh: outcome.freshContext };
    case 'plan_revised':
      return { kind: 'revised' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'expired':
      return { kind: 'expired' };
    default:
      return { kind: 'closed' };
  }
}

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

/**
 * Text of a version status; an approval names the mode with the shell's label (one label per mode
 * everywhere, R2W-03) and a fresh context as "Implemented in a new conversation (mode)".
 */
export function planStatusLabel(status: PlanVersionStatus, t: Translate): string {
  switch (status.kind) {
    case 'approved': {
      const mode = t(`shell.permissionMode.${status.mode}`);
      return status.fresh
        ? t('decisions.versions.status.approvedFresh', { mode })
        : t('decisions.versions.status.approved', { mode });
    }
    case 'open':
    case 'waiting':
    case 'revised':
    case 'cancelled':
    case 'expired':
    case 'closed':
      return t(`decisions.versions.status.${status.kind}`);
  }
}

function isPlan(decision: Decision): decision is PlanDecision {
  return decision.kind === 'plan';
}

/**
 * All versions, newest first. An open/expired plan decision of the view is the truth for its
 * version (status, text – also before the next `plan.list` answer); a listed version takes its
 * status from the transcript outcome, else from the list; the copy adds its text (or its version
 * when nothing else knows it).
 */
export function mergePlanVersions(
  listed: readonly PlanVersionInfo[] | null,
  decisions: readonly Decision[],
  outcomes: ReadonlyMap<DecisionId, DecisionOutcome>,
  copy: PlanCopy | null,
): PlanVersionEntry[] {
  const byVersion = new Map<number, PlanVersionEntry>();
  for (const info of listed ?? []) {
    const copied = copy?.decisionId === info.decisionId ? copy.plan : null;
    byVersion.set(info.version, {
      version: info.version,
      decisionId: info.decisionId,
      createdAt: info.createdAt,
      planFilePath: info.planFilePath,
      stored: info.stored,
      status: planStatusOf(outcomes.get(info.decisionId) ?? info.outcome),
      knownText: copied,
      knownPreviousText: null,
    });
  }
  for (const decision of decisions) {
    if (!isPlan(decision)) continue;
    const info = byVersion.get(decision.version);
    byVersion.set(decision.version, {
      version: decision.version,
      decisionId: decision.id,
      createdAt: info?.createdAt ?? decision.createdAt,
      planFilePath: decision.planFilePath,
      stored: info?.stored ?? true,
      status: { kind: decision.state === 'open' ? 'open' : 'waiting' },
      knownText: decision.plan,
      knownPreviousText: decision.previousVersionPlan,
    });
  }
  if (copy !== null && !byVersion.has(copy.version)) {
    byVersion.set(copy.version, {
      version: copy.version,
      decisionId: copy.decisionId,
      createdAt: null,
      planFilePath: copy.planFilePath,
      stored: true,
      status: planStatusOf(outcomes.get(copy.decisionId) ?? null),
      knownText: copy.plan,
      knownPreviousText: null,
    });
  }
  return [...byVersion.values()].sort((a, b) => b.version - a.version);
}

/** The version before `version` (the newest older one; usually v(n−1)), or null. */
export function previousPlanVersion(
  entries: readonly PlanVersionEntry[],
  version: number,
): PlanVersionEntry | null {
  return entries.find((entry) => entry.version < version) ?? null;
}

/** What the plan tab shows: the plan file ('current') or one stored version. */
export type PlanPanelView = 'current' | number;

export interface PlanViewContext {
  /** A `Write` on the plan file is running (live preview). */
  liveItemId: string | null;
  /** The plan file path is known (detail `planFile`, a matching write or a decision). */
  hasFile: boolean;
  /** Time (ms) of the last finished write on the plan file (detail or transcript), null if unknown. */
  fileWrittenAt: number | null;
  /** Newest first. */
  entries: readonly PlanVersionEntry[];
}

/**
 * The view without a choice of the user: a running write → the file; else the open (or expired)
 * decision's version; else the file when it changed after the newest version (planning goes on);
 * else the newest version; else the file; null = nothing to show ("No plan yet").
 */
export function automaticPlanView(context: PlanViewContext): PlanPanelView | null {
  if (context.liveItemId !== null) return 'current';
  const pending = context.entries.find((entry) => isPendingStatus(entry.status));
  if (pending !== undefined) return pending.version;
  const latest = context.entries[0];
  if (latest === undefined) return context.hasFile ? 'current' : null;
  if (context.hasFile && context.fileWrittenAt !== null && latest.createdAt !== null) {
    const created = Date.parse(latest.createdAt);
    if (Number.isFinite(created) && context.fileWrittenAt > created) return 'current';
  }
  return latest.version;
}

/** A choice of the plan tab's view (bar-store), with what was current when it was made. */
export interface PlanViewChoice {
  view: PlanPanelView;
  /** Set by "Open plan" on a card: honoured only while this decision is open or expired. */
  decisionId: DecisionId | null;
  /** Newest version when the choice was made: a newer version brings back the automatic view. */
  basisVersion: number | null;
  /** Running write when the choice was made: a NEW running write brings back the automatic view. */
  basisLiveItemId: string | null;
}

/**
 * The view the panel shows: the user's choice while it is still meaningful (see PlanViewChoice),
 * else the automatic view (focus stays with the user, but a new version or a new live write wins).
 */
export function resolvePlanView(
  choice: PlanViewChoice | null,
  context: PlanViewContext,
): PlanPanelView | null {
  const automatic = automaticPlanView(context);
  if (choice === null) return automatic;
  const { decisionId } = choice;
  const pending =
    decisionId === null ||
    context.entries.some((entry) => entry.decisionId === decisionId && isPendingStatus(entry.status));
  if (!pending) return automatic;
  if (context.liveItemId !== null && context.liveItemId !== choice.basisLiveItemId) return automatic;
  const latest = context.entries[0]?.version ?? null;
  if (latest !== null && choice.basisVersion !== null && latest > choice.basisVersion) return automatic;
  return choice.view;
}
