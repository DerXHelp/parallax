/**
 * Step 7 of `pnpm cli-check` (WP-62): automatic cleanup outside the repo – only data that is
 * provably the check's own (docs/sdk-upgrade.md "Rückbau"):
 * - the probe's scratch folder `%TEMP%\parallax-cli-check-<stamp>` (work dir + temp home);
 * - CLI transcript folders `~/.claude/projects/<sanitized cwd>` of the probe's and the smoke's
 *   working directories – deleted only when every `cwd` recorded in their JSONL lies inside the own
 *   temp root (otherwise left in place and reported);
 * - CLI task folders `%TEMP%\claude\<hash>\<session-id>` of the own session ids (probe stream +
 *   the verified transcripts), and a `<hash>` folder left empty by that.
 * Plan files (`~/.claude/plans`, created during the run) and project entries in `~/.claude.json`
 * are only reported. Every root is checked against its expected name prefix before anything is
 * deleted.
 */
import { readdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isWindowsPathInside, windowsBaseName, windowsPathsEqual } from '@shared/paths';
import type { CleanupReport } from './report';

/** Name prefixes of the temp roots this check may clean (probe scratch, live smoke root). */
export const OWN_ROOT_PREFIXES: readonly string[] = ['parallax-cli-check-', 'parallax-live-e2e-'];

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The folder name the CLI uses for a working directory under `~/.claude/projects`. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** True for a root the check may clean: directly inside `tempDir`, with an own name prefix. */
export function isOwnRoot(root: string, tempDir: string): boolean {
  const name = windowsBaseName(root);
  return OWN_ROOT_PREFIXES.some((prefix) => name.startsWith(prefix)) && windowsPathsEqual(path.win32.dirname(root), tempDir);
}

async function entries(dir: string): Promise<{ name: string; isDirectory: boolean }[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    return [];
  }
}

const cwdLineSchema = z.looseObject({ cwd: z.string() });

export interface TranscriptDir {
  dir: string;
  /** Session ids = JSONL file names. */
  sessionIds: string[];
  /** Every recorded cwd lies inside the root (and there is at least one). */
  verified: boolean;
  reason: string;
}

/** Transcript folders of working directories inside `root`, verified by their recorded `cwd`s. */
export async function findTranscriptDirs(projectsDir: string, root: string): Promise<TranscriptDir[]> {
  const prefix = projectDirName(root).toLowerCase();
  const found: TranscriptDir[] = [];
  for (const entry of await entries(projectsDir)) {
    if (!entry.isDirectory) continue;
    const name = entry.name.toLowerCase();
    if (name !== prefix && !name.startsWith(`${prefix}-`)) continue;
    const dir = path.join(projectsDir, entry.name);
    const sessionIds: string[] = [];
    let cwds = 0;
    let foreign: string | null = null;
    for (const file of await entries(dir)) {
      if (file.isDirectory || !file.name.endsWith('.jsonl')) continue;
      sessionIds.push(file.name.slice(0, -'.jsonl'.length));
      const text = await readFile(path.join(dir, file.name), 'utf8').catch(() => '');
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes('"cwd"')) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const cwd = cwdLineSchema.safeParse(parsed);
        if (!cwd.success) continue;
        cwds += 1;
        if (!isWindowsPathInside(cwd.data.cwd, root)) foreign ??= cwd.data.cwd;
      }
    }
    const verified = cwds > 0 && foreign === null;
    found.push({
      dir,
      sessionIds: sessionIds.sort(),
      verified,
      reason: verified
        ? `${String(cwds)} cwd lines inside ${root}`
        : foreign !== null
          ? `foreign cwd ${foreign}`
          : 'no cwd recorded',
    });
  }
  return found;
}

export interface CleanupInput {
  /** Own temp roots (probe scratch; the smoke's root, which the smoke already removed). */
  roots: string[];
  /** Roots that are deleted themselves (the probe scratch). */
  deleteRoots: string[];
  /** Session ids from the probe stream (more come from the verified transcripts). */
  sessionIds: string[];
  /** `CLAUDE_CONFIG_DIR` of the runs, else `~/.claude`. */
  configDir: string;
  /** `~/.claude.json` (or `<CLAUDE_CONFIG_DIR>\.claude.json`). */
  claudeJson: string;
  /** os.tmpdir(). */
  tempDir: string;
  /** Start of the check (plan files newer than this are reported). */
  since: Date;
}

async function removeDir(target: string, report: CleanupReport): Promise<boolean> {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    report.deleted.push(target);
    return true;
  } catch (error) {
    report.errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

const claudeJsonSchema = z.looseObject({ projects: z.record(z.string(), z.unknown()).catch({}) });

/** Runs the cleanup; never throws (errors land in the report). */
export async function cleanupOwnData(input: CleanupInput): Promise<CleanupReport> {
  const report: CleanupReport = { deleted: [], kept: [], errors: [] };
  const roots = input.roots.filter((root) => {
    if (isOwnRoot(root, input.tempDir)) return true;
    report.kept.push({ path: root, reason: 'not an own temp root (name/location check failed) – nothing cleaned for it' });
    return false;
  });
  const sessionIds = new Set(input.sessionIds.filter((id) => SESSION_ID.test(id)));

  // 1. CLI transcripts of the own working directories.
  const projectsDir = path.join(input.configDir, 'projects');
  for (const root of roots) {
    for (const transcript of await findTranscriptDirs(projectsDir, root)) {
      if (!transcript.verified) {
        report.kept.push({ path: transcript.dir, reason: `transcripts not verified as own (${transcript.reason})` });
        continue;
      }
      for (const id of transcript.sessionIds) if (SESSION_ID.test(id)) sessionIds.add(id);
      await removeDir(transcript.dir, report);
    }
  }

  // 2. CLI task folders of the own sessions.
  const tasksRoot = path.join(input.tempDir, 'claude');
  for (const hash of await entries(tasksRoot)) {
    if (!hash.isDirectory) continue;
    const hashDir = path.join(tasksRoot, hash.name);
    let removed = false;
    for (const child of await entries(hashDir)) {
      if (child.isDirectory && sessionIds.has(child.name)) removed = (await removeDir(path.join(hashDir, child.name), report)) || removed;
    }
    if (removed && (await entries(hashDir)).length === 0) {
      try {
        await rmdir(hashDir);
        report.deleted.push(hashDir);
      } catch (error) {
        report.errors.push(`${hashDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // 3. The probe's scratch folder.
  for (const root of input.deleteRoots) {
    if (!roots.includes(root)) continue;
    await removeDir(root, report);
  }

  // 4. Only reported: plan files written during the run, project entries in ~/.claude.json.
  const plansDir = path.join(input.configDir, 'plans');
  for (const plan of await entries(plansDir)) {
    if (plan.isDirectory || !plan.name.endsWith('.md')) continue;
    const file = path.join(plansDir, plan.name);
    const info = await stat(file).catch(() => null);
    if (info !== null && info.mtime >= input.since) {
      report.kept.push({ path: file, reason: 'plan file written during the check (only reported; may be a parallel session)' });
    }
  }
  try {
    const parsed = claudeJsonSchema.safeParse(JSON.parse(await readFile(input.claudeJson, 'utf8')));
    const keys = parsed.success ? Object.keys(parsed.data.projects) : [];
    const own = keys.filter((key) => roots.some((root) => isWindowsPathInside(key, root)));
    if (own.length > 0) {
      report.kept.push({
        path: input.claudeJson,
        reason: `${String(own.length)} project entr${own.length === 1 ? 'y' : 'ies'} of own temp folders (only reported)`,
      });
    }
  } catch {
    // no ~/.claude.json or unreadable: nothing to report
  }
  report.deleted.sort();
  return report;
}
