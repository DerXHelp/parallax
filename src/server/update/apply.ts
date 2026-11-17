/**
 * The hand-over to the orchestrator (WP-87 §2.1 "Anwenden/Zurück", E1): the server starts the
 * launcher of its OWN (old) version with `--apply-update` (handoff.ts `orchestratorCommand`) –
 * hidden, detached, no shell, absolute `node.exe`, stdout as a pipe, the server's environment – and
 * waits at most `APPLY_TIMEOUTS.handshakeMs` for one handshake line:
 * - `PARALLAX-APPLY-READY` → the pipe is closed, the child unref'd; the server may shut down;
 * - `PARALLAX-APPLY-FAILED <reason>`, the end of the process, a spawn error → that reason (the
 *   process end without a line → `handshake`), the server keeps running;
 * - no line in time, or an unreadable one (its stdout carries nothing but the handshake – 87b) →
 *   the orchestrator's tree is killed BEFORE the answer `handshake`: a late READY must never let
 *   it shut down a server that already gave up (it checks at most `handshakeMs − 5 s` itself).
 *   Blank lines are ignored.
 */
import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import type { UpdateRestartFailedReason } from '@shared/errors';
import { spawnHidden } from '../lib/process';
import { APPLY_TIMEOUTS, parseHandshakeLine, type OrchestratorCommand } from './handoff';

/** The part of a ChildProcess the hand-over needs (tests pass an EventEmitter). */
export interface OrchestratorChild {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  on(event: 'error', listener: (...args: unknown[]) => void): unknown;
  once(event: 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
  removeListener(event: 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
  unref(): void;
}

export type SpawnOrchestrator = (command: OrchestratorCommand) => OrchestratorChild;

/** `spawnHidden` with `detached`, stdout piped, stdin/stderr ignored (the orchestrator logs to a file). */
export const spawnOrchestrator: SpawnOrchestrator = (command) =>
  spawnHidden(command.file, command.args, {
    cwd: command.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

export type HandshakeResult =
  { kind: 'ready'; pid: number } | { kind: 'failed'; reason: UpdateRestartFailedReason };

export interface HandOverDeps {
  spawn: SpawnOrchestrator;
  kill: (pid: number) => Promise<void>;
  log: Logger;
  /** Default `APPLY_TIMEOUTS.handshakeMs`. */
  timeoutMs?: number;
}

/** Text without a newline longer than this is no handshake line. */
const MAX_BUFFER_CHARS = 64 * 1024;

/** No handshake line in time, or an unreadable one: the orchestrator may still run. */
type Waited = HandshakeResult | { kind: 'unanswered'; why: 'timeout' | 'unreadable' };

function waitForLine(child: OrchestratorChild, pid: number, timeoutMs: number): Promise<Waited> {
  return new Promise<Waited>((resolve) => {
    const stdout = child.stdout;
    let buffer = '';
    let settled = false;
    const check = (line: string): void => {
      const parsed = parseHandshakeLine(line);
      if (parsed === null) finish({ kind: 'unanswered', why: 'unreadable' });
      else finish(parsed.kind === 'ready' ? { kind: 'ready', pid } : parsed);
    };
    const onData = (chunk: unknown): void => {
      buffer += typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      for (let index = buffer.indexOf('\n'); index !== -1 && !settled; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== '') check(line);
      }
      if (!settled && buffer.length > MAX_BUFFER_CHARS) finish({ kind: 'unanswered', why: 'unreadable' });
    };
    // The process ended: a last FAILED line without newline still names the reason; anything else
    // (also a READY right before the end – nobody is left to switch) is a failed handshake.
    const onClose = (): void => {
      const last = parseHandshakeLine(buffer);
      finish(last?.kind === 'failed' ? last : { kind: 'failed', reason: 'handshake' });
    };
    const onError = (): void => {
      finish({ kind: 'failed', reason: 'spawn' });
    };
    const timer = setTimeout(() => {
      finish({ kind: 'unanswered', why: 'timeout' });
    }, timeoutMs);
    timer.unref();
    function finish(result: Waited): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout?.removeListener('data', onData);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      resolve(result);
    }
    stdout?.on('data', onData);
    child.once('close', onClose);
    child.once('error', onError);
  });
}

/** Starts the orchestrator and waits for its handshake (see the file comment). Never throws. */
export async function handOver(command: OrchestratorCommand, deps: HandOverDeps): Promise<HandshakeResult> {
  let child: OrchestratorChild;
  try {
    child = deps.spawn(command);
  } catch (error) {
    deps.log.error({ err: error }, 'the update orchestrator could not be started');
    return { kind: 'failed', reason: 'spawn' };
  }
  // A late `error` (a failed spawn reports ENOENT asynchronously) must never be unhandled.
  child.on('error', (error: unknown) => {
    deps.log.warn({ err: error }, 'update orchestrator process error');
  });
  const pid = child.pid;
  if (pid === undefined) {
    // A failed spawn: the child emits `error` (ENOENT …); nothing runs.
    child.stdout?.destroy();
    return { kind: 'failed', reason: 'spawn' };
  }
  const result = await waitForLine(child, pid, deps.timeoutMs ?? APPLY_TIMEOUTS.handshakeMs);
  child.stdout?.destroy();
  if (result.kind === 'ready') {
    child.unref();
    return result;
  }
  if (result.kind === 'unanswered') {
    deps.log.warn({ pid, why: result.why }, 'no valid handshake from the update orchestrator - ending it');
    await deps.kill(pid).catch((error: unknown) => {
      deps.log.warn({ err: error, pid }, 'the update orchestrator could not be ended');
    });
    return { kind: 'failed', reason: 'handshake' };
  }
  deps.log.warn({ pid, reason: result.reason }, 'the update orchestrator refused the switch');
  return result;
}
