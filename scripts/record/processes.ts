/**
 * Windows process-tree helpers for the recorder: snapshot via CIM (PowerShell, hidden window,
 * argument array, no shell) and tree kill via `taskkill /T /F`. Only names and ids are read –
 * command lines may contain secrets and are never recorded.
 */
import { execFile } from 'node:child_process';
import { z } from 'zod';

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  /** Creation time (ISO); together with pid it identifies a process despite pid reuse. */
  created: string;
}

const cimRowSchema = z.object({
  ProcessId: z.number(),
  ParentProcessId: z.number(),
  Name: z.string().nullable(),
  Created: z.string().nullable(),
});

const SNAPSHOT_COMMAND =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,' +
  '@{n="Created";e={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { $null }}} ' +
  '| ConvertTo-Json -Compress';

function run(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(new Error(error.message, { cause: error }));
        else resolve(stdout);
      },
    );
  });
}

/** All processes of the machine (pid, parent pid, name, creation time). */
export async function listProcesses(): Promise<ProcInfo[]> {
  const stdout = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SNAPSHOT_COMMAND],
    30_000,
  );
  const parsed = z.array(cimRowSchema).parse(JSON.parse(stdout) as unknown);
  return parsed.map((row) => ({
    pid: row.ProcessId,
    ppid: row.ParentProcessId,
    name: row.Name ?? '',
    created: row.Created ?? '',
  }));
}

/** The process `rootPid` itself (if alive) plus all transitive children. */
export function processTree(all: readonly ProcInfo[], rootPid: number): ProcInfo[] {
  const root = all.find((proc) => proc.pid === rootPid);
  const result: ProcInfo[] = root ? [root] : [];
  const queue = [rootPid];
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const proc of all) {
      if (proc.ppid === parent && !seen.has(proc.pid)) {
        // A child cannot be older than its parent; protects against pid reuse of the parent.
        const parentInfo = all.find((candidate) => candidate.pid === parent);
        if (
          parentInfo &&
          proc.created !== '' &&
          parentInfo.created !== '' &&
          proc.created < parentInfo.created
        ) {
          continue;
        }
        seen.add(proc.pid);
        result.push(proc);
        queue.push(proc.pid);
      }
    }
  }
  return result;
}

/** Processes from `before` that still exist (same pid and creation time) in `after`. */
export function survivors(before: readonly ProcInfo[], after: readonly ProcInfo[]): ProcInfo[] {
  return before.filter((old) => after.some((now) => now.pid === old.pid && now.created === old.created));
}

/** `taskkill /PID <pid> /T /F`; resolves with the tool output, never throws. */
export async function killTree(pid: number): Promise<string> {
  try {
    return (await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 15_000)).trim();
  } catch (error) {
    return `taskkill failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
