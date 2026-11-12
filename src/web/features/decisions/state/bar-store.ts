import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { permissionModeSchema, type DecisionId, type PermissionMode } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { Decision, PlanDecision } from '@shared/model';
import { readStorage, storageKey, writeStorage } from '@web/lib/storage';
import type { PlanViewChoice } from '../lib/plan-versions';

/**
 * Feature state of the decision bar (architecture §2.4: feature state lives in
 * `features/<f>/state`): which decision the bar shows per session, the plan shown in the side
 * panel tab "Plan" (open/closed and focus belong to the host, shell/side-panel) and which of its
 * versions the user picked, the decisions this window answered itself (to tell them apart from
 * answers in other windows), failed "fresh context" answers and the remembered "Implement" choice.
 * Never part of the client store (WP-14).
 */

/** Plan shown in the side panel; a copy keeps it readable after the decision closed. */
export interface PlanPanelState {
  decisionId: DecisionId;
  version: number;
  plan: string;
  planFilePath: string | null;
}

/** A failed "Implement with fresh context" (WP-56): shown in the card of `decisionId`. */
export interface FreshContextError {
  decisionId: DecisionId;
  error: ErrorPayload;
}

interface BarState {
  /** Decision the user picked to view (else the bar shows the oldest open one). */
  selected: Readonly<Record<string, DecisionId>>;
  panels: Readonly<Record<string, PlanPanelState>>;
  /** Version picked in the plan tab per session (absent = automatic, lib/plan-versions.ts). */
  views: Readonly<Record<string, PlanViewChoice>>;
  /** Last failed fresh-context answer per session. */
  freshErrors: Readonly<Record<string, FreshContextError>>;
}

const store = createStore<BarState>(() => ({ selected: {}, panels: {}, views: {}, freshErrors: {} }));

/** Decisions answered or cancelled by THIS window (insertion order, capped). */
const local = new Set<DecisionId>();
const LOCAL_MAX = 500;

export function useSelectedDecisionId(sessionKey: string): DecisionId | null {
  return useStore(store, (state) => state.selected[sessionKey] ?? null);
}

export function selectDecision(sessionKey: string, decisionId: DecisionId | null): void {
  store.setState((state) => {
    const { [sessionKey]: _previous, ...rest } = state.selected;
    return { selected: decisionId === null ? rest : { ...rest, [sessionKey]: decisionId } };
  });
}

/**
 * The decision the bar shows: the one the user picked (if still there), else the oldest OPEN
 * one, else the oldest expired one (A.6: oldest first; expired cards only exist without a
 * process, A.10).
 */
export function pickDisplayedDecision(
  decisions: readonly Decision[],
  selectedId: DecisionId | null,
): Decision | null {
  if (selectedId !== null) {
    const selected = decisions.find((decision) => decision.id === selectedId);
    if (selected !== undefined) return selected;
  }
  return decisions.find((decision) => decision.state === 'open') ?? decisions[0] ?? null;
}

// ---- plan panel ----

export function usePlanPanel(sessionKey: string): PlanPanelState | null {
  return useStore(store, (state) => state.panels[sessionKey] ?? null);
}

/**
 * The plan the side panel tab "Plan" shows (the caller opens the tab via requestShell): a copy of
 * the decision and its version as the tab's view while the decision is open or expired.
 */
export function setPanelPlan(sessionKey: string, decision: PlanDecision): void {
  store.setState((state) => ({
    panels: {
      ...state.panels,
      [sessionKey]: {
        decisionId: decision.id,
        version: decision.version,
        plan: decision.plan,
        planFilePath: decision.planFilePath,
      },
    },
    views: {
      ...state.views,
      [sessionKey]: {
        view: decision.version,
        decisionId: decision.id,
        basisVersion: null,
        basisLiveItemId: null,
      },
    },
  }));
}

export function usePlanViewChoice(sessionKey: string): PlanViewChoice | null {
  return useStore(store, (state) => state.views[sessionKey] ?? null);
}

/** The user picked a version (or the plan file) in the plan tab. */
export function choosePlanView(sessionKey: string, choice: PlanViewChoice): void {
  store.setState((state) => ({ views: { ...state.views, [sessionKey]: choice } }));
}

// ---- failed "fresh context" answers (WP-56) ----

export function useFreshContextError(sessionKey: string): FreshContextError | null {
  return useStore(store, (state) => state.freshErrors[sessionKey] ?? null);
}

export function setFreshContextError(sessionKey: string, decisionId: DecisionId, error: ErrorPayload): void {
  store.setState((state) => ({ freshErrors: { ...state.freshErrors, [sessionKey]: { decisionId, error } } }));
}

export function clearFreshContextError(sessionKey: string): void {
  if (store.getState().freshErrors[sessionKey] === undefined) return;
  store.setState((state) => {
    const { [sessionKey]: _cleared, ...rest } = state.freshErrors;
    return { freshErrors: rest };
  });
}

// ---- answered by this window ----

/** Marks decisions as answered/cancelled by this window (no "answered elsewhere" notice). */
export function markLocalResolution(decisionIds: readonly DecisionId[]): void {
  for (const id of decisionIds) {
    local.delete(id);
    local.add(id);
  }
  while (local.size > LOCAL_MAX) {
    const oldest = local.values().next();
    if (oldest.done === true) break;
    local.delete(oldest.value);
  }
}

/** The answer of this window failed: a later resolution elsewhere is reported again. */
export function unmarkLocalResolution(decisionId: DecisionId): void {
  local.delete(decisionId);
}

export function isLocalResolution(decisionId: DecisionId): boolean {
  return local.has(decisionId);
}

// ---- remembered "Implement" choice (Plan "Split-Button merkt sich die letzte Wahl") ----

const APPROVE_MODE_KEY = storageKey('decisions', 'approveMode');
/** WP-56 (ADR-147): "with fresh context" is remembered next to the mode. */
const APPROVE_FRESH_KEY = storageKey('decisions', 'approveFresh');

export function readApproveMode(): PermissionMode | null {
  const parsed = permissionModeSchema.safeParse(readStorage('local', APPROVE_MODE_KEY));
  return parsed.success ? parsed.data : null;
}

/** Remembers the mode – never bypass (it must be picked every time, C.3). */
export function writeApproveMode(mode: PermissionMode): void {
  if (mode === 'bypassPermissions') return;
  writeStorage('local', APPROVE_MODE_KEY, mode);
}

export function readApproveFresh(): boolean {
  return readStorage('local', APPROVE_FRESH_KEY) === 'true';
}

export function writeApproveFresh(fresh: boolean): void {
  writeStorage('local', APPROVE_FRESH_KEY, fresh ? 'true' : 'false');
}

/** Tests: forget everything (the module state is global). */
export function resetDecisionBarState(): void {
  store.setState({ selected: {}, panels: {}, views: {}, freshErrors: {} });
  local.clear();
}
