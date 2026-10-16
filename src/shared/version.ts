/**
 * Version rule C.7 (R3-01, ADR-070): one implementation for server (`claude/resolveClaude.ts`,
 * preflight) and web (`lib/version.ts`, header/sidebar display) – Phase 2 follow-up (WP-30 §4.9).
 * Pure, no imports.
 */

interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function comparePre(a: readonly string[], b: readonly string[]): number {
  // A release (no pre-release part) is newer than any pre-release of the same core version.
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Semver order (-1, 0, 1); build metadata ignored; null if one side is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < 3; i++) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return comparePre(x.pre, y.pre);
}

export type CliVersionStatus = 'ok' | 'too_old' | 'unknown';

/** C.7: `too_old` (red) if `cli` < `required`; `unknown` if either is missing or unparsable. */
export function cliVersionStatus(cli: string | null, required: string | null): CliVersionStatus {
  if (cli === null || required === null) return 'unknown';
  const order = compareVersions(cli, required);
  if (order === null) return 'unknown';
  return order < 0 ? 'too_old' : 'ok';
}
