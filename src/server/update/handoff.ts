/**
 * Hand-over from the server to the orchestrator (WP-87 §1.7, E1): the server of the OLD version
 * starts `versions\<old>\dist\launcher.js --apply-update=<v>` (the orchestrator, WP-87b) and waits
 * for one handshake line on its stdout before it shuts down. Stable across versions (the old code
 * always starts the new one): flags, lines and timeouts change only additively.
 */
import path from 'node:path';
import { UPDATE_RESTART_FAILED_REASONS, type UpdateRestartFailedReason } from '@shared/errors';
import { PACKAGE_NODE_FLAGS } from '../launcher/release';

export const APPLY_UPDATE_FLAG = '--apply-update';
export const RESTORE_FLAG = '--restore';
export const WAIT_PID_FLAG = '--wait-pid';

/** The orchestrator checked everything it can before the switch: the server may shut down now. */
export const APPLY_READY_LINE = 'PARALLAX-APPLY-READY';
/** `PARALLAX-APPLY-FAILED <reason>`: nothing switched, the server keeps running. */
export const APPLY_FAILED_PREFIX = 'PARALLAX-APPLY-FAILED';

export const APPLY_TIMEOUTS = {
  /** Server: spawn → handshake line. */
  handshakeMs: 20_000,
  /** Orchestrator: start lock of the data directory and install lock of the root. */
  lockMs: 30_000,
  /** Orchestrator: the old server releases the home lock and its process ends. */
  serverExitMs: 45_000,
  /** After `taskkill /T /F` until the lock is free. */
  killGraceMs: 10_000,
  /** The new version is healthy (overridable by `UPDATE_READY_TIMEOUT_ENV`). */
  readyMs: 60_000,
} as const;

/** Seconds 10…600 – antivirus scanners slow down the first start (WP-83 §9.3). */
export const UPDATE_READY_TIMEOUT_ENV = 'PARALLAX_UPDATE_READY_TIMEOUT_S';

export function readyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[UPDATE_READY_TIMEOUT_ENV];
  if (raw === undefined || !/^\d{1,3}$/u.test(raw.trim())) return APPLY_TIMEOUTS.readyMs;
  const seconds = Number(raw.trim());
  return seconds >= 10 && seconds <= 600 ? seconds * 1000 : APPLY_TIMEOUTS.readyMs;
}

export interface ApplyRequest {
  /** Target version (`versions\<v>` must be staged). */
  version: string;
  /** Switch with the backup of that version (`needsRestore`, WP-83 §9.4). */
  restore: boolean;
  /** PID of the server that hands over (the orchestrator waits for its end). */
  waitPid: number;
  installRoot: string;
  /** `serverArgsFor(config)` of the running server: the new version starts alike. */
  serverArgs: readonly string[];
}

export interface OrchestratorCommand {
  file: string;
  args: string[];
  /** The root folder – never a version folder (a long-lived process would lock it). */
  cwd: string;
}

/** `node.exe <flags> <ownVersionDir>\dist\launcher.js --install-root=… --apply-update=… …`. */
export function orchestratorCommand(
  request: ApplyRequest,
  ownVersionDir: string,
  nodeExe: string = process.execPath,
): OrchestratorCommand {
  return {
    file: nodeExe,
    args: [
      ...PACKAGE_NODE_FLAGS,
      path.join(ownVersionDir, 'dist', 'launcher.js'),
      `--install-root=${request.installRoot}`,
      `${APPLY_UPDATE_FLAG}=${request.version}`,
      ...(request.restore ? [RESTORE_FLAG] : []),
      `${WAIT_PID_FLAG}=${String(request.waitPid)}`,
      ...request.serverArgs,
    ],
    cwd: request.installRoot,
  };
}

export type HandshakeLine = { kind: 'ready' } | { kind: 'failed'; reason: UpdateRestartFailedReason };

/** One stdout line of the orchestrator; null = not a handshake line (ignored). */
export function parseHandshakeLine(line: string): HandshakeLine | null {
  const text = line.trim();
  if (text === APPLY_READY_LINE) return { kind: 'ready' };
  if (!text.startsWith(`${APPLY_FAILED_PREFIX} `)) return null;
  const reason = text.slice(APPLY_FAILED_PREFIX.length + 1).trim();
  const known = UPDATE_RESTART_FAILED_REASONS.find((r) => r === reason);
  return { kind: 'failed', reason: known ?? 'spawn' };
}

export function handshakeLine(result: HandshakeLine): string {
  return result.kind === 'ready' ? APPLY_READY_LINE : `${APPLY_FAILED_PREFIX} ${result.reason}`;
}
