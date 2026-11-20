import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ErrorPayload } from '@shared/errors';
import type { ShellKind } from '@shared/model';
import {
  TERMINAL_LIMITS,
  type TerminalExitReason,
  type TerminalId,
  type TerminalInfo,
} from '@shared/terminal';
import { readStorage, storageKey, writeStorage } from '@web/lib/storage';
import type { TerminalConnectionStatus } from './socket';

/**
 * Feature state of the terminal panel (WP-99b), one Zustand store per session key: the entry's
 * terminals as the server lists them, the active one, availability, pending `open` requests and the
 * last error. The active terminal survives closing and reopening the panel; everything that belongs
 * to one socket is reset when the panel connects again (`resetConnection`). Never part of the client
 * store. Written only by `controller.ts`.
 */

export interface PendingOpen {
  requestId: string;
  shell: ShellKind;
}

export interface TerminalLimitsView {
  perEntry: number;
  total: number;
}

export interface TerminalSessionState {
  /**
   * The controller whose connection the state describes (`TerminalController.id`); a new panel shows
   * nothing of an earlier mount until its own `start` reset the state.
   */
  owner: number | null;
  connection: TerminalConnectionStatus;
  /** Close code of a final failure (4404, 4426), else null. */
  failure: number | null;
  /** From `welcome`; null until it arrived. */
  available: boolean | null;
  /** Why the terminal is unavailable (`welcome.error`). */
  unavailable: ErrorPayload | null;
  limits: TerminalLimitsView;
  /** The first `terminals` list of this connection arrived. */
  loaded: boolean;
  items: readonly TerminalInfo[];
  activeId: TerminalId | null;
  pending: readonly PendingOpen[];
  /** Why a terminal ended (`exit.reason`), until it is closed. */
  exitReasons: Readonly<Partial<Record<TerminalId, TerminalExitReason>>>;
  /** Tab number of each terminal (`assignNumbers`); kept while the terminal exists. */
  numbers: Readonly<Partial<Record<TerminalId, number>>>;
  /** Last failed request (shown inline until dismissed or the next request). */
  error: ErrorPayload | null;
  /** Raised when the active terminal should take the focus (opened, selected). */
  focusToken: number;
}

export type TerminalStore = StoreApi<TerminalSessionState>;

const DEFAULT_LIMITS: TerminalLimitsView = {
  perEntry: TERMINAL_LIMITS.perEntry,
  total: TERMINAL_LIMITS.total,
};

function initialState(): TerminalSessionState {
  return {
    owner: null,
    connection: 'connecting',
    failure: null,
    available: null,
    unavailable: null,
    limits: DEFAULT_LIMITS,
    loaded: false,
    items: [],
    activeId: null,
    pending: [],
    exitReasons: {},
    numbers: {},
    error: null,
    focusToken: 0,
  };
}

const stores = new Map<string, TerminalStore>();

/** The store of one session (created on first use). */
export function terminalStore(sessionKey: string): TerminalStore {
  let store = stores.get(sessionKey);
  if (store === undefined) {
    store = createStore<TerminalSessionState>(initialState);
    stores.set(sessionKey, store);
  }
  return store;
}

/**
 * A new connection of `owner`: everything of the old socket goes, the active terminal and the tab
 * numbers stay.
 */
export function resetConnection(store: TerminalStore, owner: number): void {
  const { activeId, focusToken, numbers } = store.getState();
  store.setState({ ...initialState(), owner, activeId, focusToken, numbers });
}

/** Tests: forget every session. */
export function resetTerminalStores(): void {
  stores.clear();
}

export function useTerminalSession(sessionKey: string): TerminalSessionState {
  return useStore(terminalStore(sessionKey));
}

/**
 * The active terminal after the list changed: the current one if still there, else its neighbour
 * (same position, else the last), else the first; null for an empty list.
 */
export function pickActive(
  previous: readonly TerminalInfo[],
  next: readonly TerminalInfo[],
  activeId: TerminalId | null,
): TerminalId | null {
  if (activeId !== null && next.some((item) => item.terminalId === activeId)) return activeId;
  const index = activeId === null ? -1 : previous.findIndex((item) => item.terminalId === activeId);
  if (index >= 0) return (next[Math.min(index, next.length - 1)] ?? null)?.terminalId ?? null;
  return next[0]?.terminalId ?? null;
}

/**
 * Tab numbers per shell (cmd 1, cmd 2, PowerShell 1): a terminal keeps its number while it exists
 * (closing "cmd 1" does not rename "cmd 2"); a new one gets the lowest number its shell has free.
 */
export function assignNumbers(
  previous: Readonly<Partial<Record<TerminalId, number>>>,
  items: readonly TerminalInfo[],
): Record<TerminalId, number> {
  const numbers: Record<TerminalId, number> = {};
  const used = new Map<ShellKind, Set<number>>();
  const usedBy = (shell: ShellKind): Set<number> => {
    let set = used.get(shell);
    if (set === undefined) {
      set = new Set();
      used.set(shell, set);
    }
    return set;
  };
  for (const item of items) {
    const kept = previous[item.terminalId];
    if (kept === undefined || usedBy(item.shell).has(kept)) continue;
    numbers[item.terminalId] = kept;
    usedBy(item.shell).add(kept);
  }
  for (const item of items) {
    if (numbers[item.terminalId] !== undefined) continue;
    const taken = usedBy(item.shell);
    let number = 1;
    while (taken.has(number)) number++;
    numbers[item.terminalId] = number;
    taken.add(number);
  }
  return numbers;
}

// ---- Screen reader mode (one setting per window, remembered in localStorage) ----

const SCREEN_READER_KEY = storageKey('terminal', 'screenReader');

const screenReaderStore = createStore<{ enabled: boolean }>(() => ({
  enabled: readStorage('local', SCREEN_READER_KEY) === 'true',
}));

export function getScreenReaderMode(): boolean {
  return screenReaderStore.getState().enabled;
}

export function setScreenReaderMode(enabled: boolean): void {
  screenReaderStore.setState({ enabled });
  writeStorage('local', SCREEN_READER_KEY, String(enabled));
}

export function useScreenReaderMode(): boolean {
  return useStore(screenReaderStore, (state) => state.enabled);
}
