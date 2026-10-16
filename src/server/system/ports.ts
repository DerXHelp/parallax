/**
 * Port: Windows integration (Phase 2, WP-30 §4.11) – WP-33 implements (`system/console.ts`,
 * `system/fakeConsole.ts`, `system/index.ts`), the engine (WP-34) and the composition (WP-40) use
 * it. Types only; frozen like src/shared.
 *
 * - ConsoleLauncher (ADR-104): a VISIBLE console window running `claude --resume <id>` – Node/libuv
 *   always hands std handles to a spawned process, so the console is opened through a PowerShell
 *   helper (`Start-Process`, constant script, data in environment variables), never `cmd /c start`.
 * - SystemIntegration (ADR-109, ADR-110): autostart shortcut and the opt-in protocol handler
 *   `parallax:`; only on the productive server (`available`), never in tests/dev/fake.
 */
import type { EntryId } from '@shared/common';
import type { HostWarning, Settings } from '@shared/model';
import type { ConsoleLaunchSpec } from '../claude/ports';

export interface ConsoleProcess {
  /** claude.exe in the console; null = unknown. */
  pid: number | null;
  /** Exact process start time (PID-reuse check); null = unknown. */
  startedAt: Date | null;
}

export type ConsoleOpenResult =
  { kind: 'opened'; process: ConsoleProcess } | { kind: 'failed'; reason: string };

/** Never throws. */
export interface ConsoleLauncher {
  open(spec: ConsoleLaunchSpec): Promise<ConsoleOpenResult>;
  /** 'unknown' never counts as ended (like ADR-051). */
  state(process: ConsoleProcess): Promise<'running' | 'ended' | 'unknown'>;
}

/** Never throws; failures become host warnings (AUTOSTART_FAILED, PROTOCOL_HANDLER_FAILED). */
export interface SystemIntegration {
  /** HostState.systemIntegration. */
  readonly available: boolean;
  /** Reconcile autostart and protocol handler with the settings (server start, every settings.update). */
  apply(settings: Settings): Promise<void>;
  /** `parallax://session/<id>` if `openOnClick` is on and the handler is registered, else null. */
  toastLaunchUri(entryId: EntryId): string | null;
  /** Warnings of the last apply (merged into HostState.warnings). */
  warnings(): HostWarning[];
  /** After every apply that changed the warnings or the registration. */
  onChange(listener: () => void): () => void;
}
