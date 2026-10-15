/**
 * Microsoft Edge lookup (WP-11 owns this file; moved from claude/preflight.ts in the R1 fixes,
 * R1-08 / ADR-024): used by `pnpm preflight` and the launcher (WP-21, Edge app mode). Never via the
 * PATH (C.9: `msedge` is not on it) and never through a shell.
 */
import path from 'node:path';
import { windowsPathIssue } from '@shared/paths';
import { parseRegDefaultValue, type RegQuery } from './registry';
import { getEnvVar, type FsProbe } from './windows';

const EDGE_APP_PATH = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe';

/**
 * msedge.exe via App Paths (HKCU, HKLM 64/32 bit) or the usual install folders (C.9). Null if none
 * exists. Every candidate is checked with `@shared/paths` and must be an `.exe` (absolute path, so
 * it can be passed to spawnHidden directly, R1-04).
 */
export async function findEdge(deps: {
  regQuery: RegQuery;
  fs: FsProbe;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<string | null> {
  const fromRegistry: string[] = [];
  for (const [key, view] of [
    [`HKCU\\${EDGE_APP_PATH}`, 64],
    [`HKLM\\${EDGE_APP_PATH}`, 64],
    [`HKLM\\${EDGE_APP_PATH}`, 32],
  ] as const) {
    const output = await deps.regQuery(key, view);
    const value = output === null ? null : parseRegDefaultValue(output, deps.env);
    if (value !== null) fromRegistry.push(value);
  }
  const folders = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA']
    .map((name) => getEnvVar(deps.env, name))
    .filter((value): value is string => value !== undefined && value !== '')
    .map((root) => path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const candidate of [...fromRegistry, ...folders]) {
    if (windowsPathIssue(candidate) !== null) continue;
    if (path.win32.extname(candidate).toLowerCase() !== '.exe') continue;
    if (await deps.fs.isFile(candidate)) return candidate;
  }
  return null;
}
