import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { permissionModeSchema, type DecisionId, type PermissionMode } from '@shared/common';
import type { Decision, PlanDecision } from '@shared/model';
import { readStorage, storageKey, writeStorage } from '@web/lib/storage';

/**
 * Feature state of the decision bar (architecture §2.4: feature state lives in
 * `features/<f>/state`): which decision the bar shows per session, the open plan panel, the
 * decisions this window answered itself (to tell them apart from answers in other windows) and
 * the remembered "Implement" choice. Never part of the client store (WP-14).
 */

/** Plan shown in the side panel; a copy keeps it readable after the decision closed. */
export interface PlanPanelState {
  decisionId: DecisionId;
  version: number;
  plan: string;
  planFilePath: string | null;
}

interface BarState {
  /** Decision the user picked to view (else the bar shows the oldest open one). */
  selected: Readonly<Record<string, DecisionId>>;
  panels: Readonly<Record<string, PlanPanelState>>;
}

const store = createStore<BarState>(() => ({ selected: {}, panels: {} }));

/** Decisions answered or cancelled by THIS window (insertion order, capped). */
const local = new Set<DecisionId>();
const LOCAL_MAX = 500;

/** Elements that opened a plan panel (focus returns there on close). */
const panelOpeners = new Map<string, HTMLElement>();

/** Sessions whose PlanSidePanel is mounted (else "Open plan" expands the plan inside the bar). */
const mountedPanels = new Map<string, number>();

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

export function openPlanPanel(sessionKey: string, decision: PlanDecision, opener?: HTMLElement | null): void {
  if (opener !== undefined && opener !== null) panelOpeners.set(sessionKey, opener);
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
  }));
}

/** Closes the panel; returns the element that opened it (if still in the document). */
export function closePlanPanel(sessionKey: string): HTMLElement | null {
  const opener = panelOpeners.get(sessionKey) ?? null;
  panelOpeners.delete(sessionKey);
  if (store.getState().panels[sessionKey] !== undefined) {
    store.setState((state) => {
      const { [sessionKey]: _closed, ...panels } = state.panels;
      return { panels };
    });
  }
  return opener?.isConnected === true ? opener : null;
}

/** Called by PlanSidePanel while mounted (ref-counted); returns the unregister function. */
export function registerPlanPanel(sessionKey: string): () => void {
  mountedPanels.set(sessionKey, (mountedPanels.get(sessionKey) ?? 0) + 1);
  return () => {
    const count = (mountedPanels.get(sessionKey) ?? 1) - 1;
    if (count <= 0) mountedPanels.delete(sessionKey);
    else mountedPanels.set(sessionKey, count);
  };
}

export function isPlanPanelMounted(sessionKey: string): boolean {
  return (mountedPanels.get(sessionKey) ?? 0) > 0;
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

export function readApproveMode(): PermissionMode | null {
  const parsed = permissionModeSchema.safeParse(readStorage('local', APPROVE_MODE_KEY));
  return parsed.success ? parsed.data : null;
}

export function writeApproveMode(mode: PermissionMode): void {
  writeStorage('local', APPROVE_MODE_KEY, mode);
}

/** Tests: forget everything (the module state is global). */
export function resetDecisionBarState(): void {
  store.setState({ selected: {}, panels: {} });
  local.clear();
  panelOpeners.clear();
  mountedPanels.clear();
}
