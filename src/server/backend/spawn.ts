/**
 * `spawnClaudeCodeProcess` wrapper (WP-13 §3.2, C.8, F.16): starts the CLI through `spawnHidden`
 * (lib/process.ts: argument array, `shell: false`, `windowsHide: true`, only absolute `.exe` paths,
 * stderr always consumed), records PID + start time and reports stderr, exit and errors.
 *
 * The forwarded `SpawnOptions.signal` is NOT given to spawn(): on Windows Node would answer an abort
 * with `TerminateProcess`, which leaves the children (Bash, MCP servers, …) running. An abort kills
 * the whole tree with `killProcessTree` instead. The start time is `now()` at spawn (orphan check
 * with tolerance, §3.5.13) – `processInfo` is too slow for this hot path.
 */
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { windowsPathKey } from '@shared/paths';
import { logger } from '../lib/logger';
import type { spawnHidden } from '../lib/process';

const log = logger.child({ module: 'backend/spawn' });

export interface SpawnerOptions {
  spawn: typeof spawnHidden;
  killProcessTree: (pid: number) => Promise<void>;
  now: () => Date;
  /**
   * The resolved `LaunchSpec.executablePath`: any other command is refused (TypeError via
   * onError), so only the resolved claude.exe is ever started (C.7, R1-04). Optional for tests.
   */
  expectedCommand?: string;
  /** → BackendEvent `spawned`. */
  onSpawned(pid: number, startedAt: Date): void;
  /** → BackendEvent `stderr` (the pipe is always read, F.16). */
  onStderr(text: string): void;
  onExit(code: number | null, signal: string | null): void;
  /**
   * Spawn failures (TypeError of assertSpawnableFile, ENOENT/EACCES …) and process errors →
   * BackendEvent `error{where:'spawn'}`. Without a preceding onSpawned (no PID) no onExit follows.
   * A synchronous failure is reported here and then rethrown to the SDK.
   */
  onError(error: Error): void;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** SpawnOptions.env may hold `undefined` values; spawn() wants plain strings. */
export function definedEnv(env: SpawnOptions['env']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

function hasPipes(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

/** Builds the `spawnClaudeCodeProcess` function for one session. */
export function createSpawner(opts: SpawnerOptions): (o: SpawnOptions) => SpawnedProcess {
  return (o) => {
    let child: ChildProcess;
    try {
      if (
        opts.expectedCommand !== undefined &&
        windowsPathKey(o.command) !== windowsPathKey(opts.expectedCommand)
      ) {
        throw new TypeError('spawn: the SDK asked for a different executable than the resolved claude.exe');
      }
      child = opts.spawn(o.command, o.args, {
        cwd: o.cwd,
        env: definedEnv(o.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        onStderr: (text) => {
          opts.onStderr(text);
        },
      });
    } catch (error) {
      const err = toError(error);
      opts.onError(err);
      throw err;
    }
    if (!hasPipes(child)) {
      // Cannot happen with stdio 'pipe'; never leave a process behind that the SDK cannot drive.
      if (child.pid !== undefined) opts.killProcessTree(child.pid).catch(() => undefined);
      const err = new Error('spawn: stdio pipes missing');
      opts.onError(err);
      throw err;
    }
    const startedAt = opts.now();
    const pid = child.pid ?? null;
    let exited = false;

    const onAbort = (): void => {
      if (pid === null || exited) return;
      opts.killProcessTree(pid).catch((error: unknown) => {
        log.warn({ pid, err: error }, 'killing the claude process tree after abort failed');
      });
    };

    child.once('exit', (code, signal) => {
      exited = true;
      o.signal.removeEventListener('abort', onAbort);
      opts.onExit(code, signal);
    });
    child.on('error', (error) => {
      // A spawn failure (ENOENT …) has no PID and no 'exit' event.
      if (pid === null) exited = true;
      opts.onError(error);
    });
    if (pid !== null) opts.onSpawned(pid, startedAt);
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
    return child;
  };
}
