/**
 * Version comparison for the display of the version rule C.7 (R3-01): the CLI version of a session
 * (`init.claude_code_version`, `SessionSummary.cliVersion`) against the minimum the SDK expects
 * (`HostState.sdkClaudeCodeVersion`). The rule itself lives in `@shared/version` (one
 * implementation for server and web, WP-30 §4.9); this module re-exports it.
 */
export { cliVersionStatus, compareVersions, type CliVersionStatus } from '@shared/version';

/** A reported version, or null when it is missing/blank (the normalizer sends '' without one). */
export function knownVersion(version: string | null): string | null {
  if (version === null) return null;
  const trimmed = version.trim();
  return trimmed === '' ? null : trimmed;
}
