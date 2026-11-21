/**
 * The Linux process table from `/proc` (WP-103, spike WP-101 §1.4) – the counterpart of the
 * Toolhelp snapshot in processNative.ts: no started process (ADR-229, ADR-231), plain file reads.
 *
 * - `/proc/<pid>/stat`: PID, `comm`, state, parent, process group, session and the start time in
 *   clock ticks after boot (field 22). `comm` is the base name of the file given to `execve`, cut to
 *   15 bytes (TASK_COMM_LEN) – the "image name" of a Linux process (`processImageName`), what `ps`,
 *   `top` and `pgrep` show. A program may rename itself: node does so at its start
 *   (`node-MainThread`). Identity is PID + start time; compare names only with names read here.
 * - Start time = `btime` (`/proc/stat`, whole seconds) + ticks / USER_HZ – the procps convention: the
 *   SAME value in every process (the orphan check compares start times of one run with those of the
 *   next one exactly, sessions/recovery.ts), at most 1 s EARLIER than the real start (btime is cut to
 *   seconds). Comparisons with an in-process clock (`now()` at spawn) need that tolerance; the ones in
 *   recovery and heartbeat have 5 s. `btime` is read once per reader (stable unless the clock is set).
 * - `cmdline` (readable for every process) and `environ` (only for processes of this user) for
 *   finding a process by its `PARALLAX_ENTRY_ID` (external console, WP-106).
 * Processes of other users stay in the table (their `stat` is world-readable); signals to them fail
 * with EPERM, so nothing of theirs can be ended.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const PROC_ROOT = '/proc';
/** USER_HZ, the unit of the times in `/proc/<pid>/stat`: 100 on every Linux architecture (`sysconf(_SC_CLK_TCK)`). */
export const PROC_CLOCK_TICKS = 100;
/** Longest `comm` (TASK_COMM_LEN 16 including the terminating NUL). */
export const PROC_COMM_MAX_BYTES = 15;

/** One line of `/proc/<pid>/stat` (the fields used here). */
export interface ProcStat {
  pid: number;
  /** Base name of the started file, at most 15 bytes (the process may rename itself). */
  comm: string;
  /** `R` running, `S` sleeping, `D` disk wait, `Z` zombie, `X` dead, … */
  state: string;
  ppid: number;
  /** Process group (= PID of its leader). */
  pgid: number;
  /** Session (= PID of its leader). */
  sid: number;
  /** Start time in clock ticks after boot. */
  startTicks: number;
}

function nonNegativeInteger(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Parses `/proc/<pid>/stat`. `comm` may contain spaces and parentheses, so it ends at the LAST `)`.
 * Null for anything malformed.
 */
export function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open <= 0 || close < open) return null;
  const pid = nonNegativeInteger(text.slice(0, open).trim());
  // Field 3 (state) is fields[0]; field n is fields[n - 3].
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const ppid = nonNegativeInteger(fields[1]);
  const pgid = nonNegativeInteger(fields[2]);
  const sid = nonNegativeInteger(fields[3]);
  const startTicks = nonNegativeInteger(fields[19]);
  if (pid === null || pid <= 0 || state === undefined || !/^[A-Za-z]$/.test(state)) return null;
  if (ppid === null || pgid === null || sid === null || startTicks === null) return null;
  return { pid, comm: text.slice(open + 1, close), state, ppid, pgid, sid, startTicks };
}

/** `btime` (boot time, seconds since the epoch) from the text of `/proc/stat`, or null. */
export function parseBootTime(text: string): number | null {
  const match = /^btime\s+(\d+)\s*$/m.exec(text);
  return match === null ? null : nonNegativeInteger(match[1]);
}

/** NUL-separated `cmdline`/`environ` text → its entries (the trailing NUL gives no empty entry). */
function nulSeparated(text: string): string[] {
  const parts = text.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

/** `environ` text → variables (entries without `=` are skipped; the first `=` separates). */
export function parseEnviron(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of nulSeparated(text)) {
    const equals = entry.indexOf('=');
    if (equals <= 0) continue;
    env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return env;
}

/** A dead or not yet reaped process (`kill(pid, 0)` still succeeds for a zombie). */
export function isEndedState(state: string): boolean {
  return state === 'Z' || state === 'X' || state === 'x';
}

/**
 * What the process table reports as `name` for a process just started from `file`: its base name
 * cut to 15 bytes (Linux `comm` after `execve`) – until the program renames itself (node does).
 */
export function processImageName(file: string): string {
  let name = path.posix.basename(file);
  while (Buffer.byteLength(name, 'utf8') > PROC_COMM_MAX_BYTES) name = name.slice(0, -1);
  return name;
}

export interface ProcfsOptions {
  /** Test seam: a folder laid out like `/proc` (default `/proc`). */
  root?: string;
  /** Test seam (default PROC_CLOCK_TICKS). */
  clockTicks?: number;
}

/** Reads `/proc` (synchronously: small kernel files, ≈ 5 ms for a desktop's processes). Never throws. */
export interface ProcfsReader {
  /** Every process (no threads); null if `/proc` cannot be listed. */
  table(): ProcStat[] | null;
  /** One process; null if it is gone or unreadable. */
  stat(pid: number): ProcStat | null;
  /** Wall-clock start (see the file comment); null without a readable `btime`. */
  startedAt(stat: ProcStat): Date | null;
  /** argv of the process; null if unreadable or empty (kernel threads, zombies). */
  commandLine(pid: number): string[] | null;
  /** Environment of a process of THIS user; null otherwise (EACCES) or if it is gone. */
  environment(pid: number): Record<string, string> | null;
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

export function createProcfsReader(options: ProcfsOptions = {}): ProcfsReader {
  const root = options.root ?? PROC_ROOT;
  const ticks = options.clockTicks ?? PROC_CLOCK_TICKS;
  let bootSeconds: number | null | undefined;

  const read = (...parts: string[]): string | null => {
    try {
      return readFileSync(path.join(root, ...parts), 'utf8');
    } catch {
      return null;
    }
  };
  const statOf = (pid: number): ProcStat | null => {
    if (!validPid(pid)) return null;
    const text = read(String(pid), 'stat');
    const parsed = text === null ? null : parseProcStat(text);
    return parsed?.pid === pid ? parsed : null;
  };

  return {
    table() {
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        return null;
      }
      const rows: ProcStat[] = [];
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        // Gone between readdir and read: simply not listed.
        const row = statOf(Number(name));
        if (row !== null) rows.push(row);
      }
      return rows;
    },
    stat: statOf,
    startedAt(stat) {
      if (bootSeconds === undefined) {
        const text = read('stat');
        bootSeconds = text === null ? null : parseBootTime(text);
      }
      if (bootSeconds === null) return null;
      return new Date(bootSeconds * 1000 + Math.round((stat.startTicks * 1000) / ticks));
    },
    commandLine(pid) {
      if (!validPid(pid)) return null;
      const text = read(String(pid), 'cmdline');
      if (text === null || text === '') return null;
      return nulSeparated(text);
    },
    environment(pid) {
      if (!validPid(pid)) return null;
      const text = read(String(pid), 'environ');
      return text === null ? null : parseEnviron(text);
    },
  };
}
