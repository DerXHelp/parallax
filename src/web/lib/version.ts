/**
 * Version comparison for the display of the version rule C.7 (R3-01): the CLI version of a session
 * (`init.claude_code_version`, `SessionSummary.cliVersion`) against the minimum the SDK expects
 * (`HostState.sdkClaudeCodeVersion`). The rule itself lives in `@shared/version` (one
 * implementation for server and web, WP-30 §4.9); this module re-exports it.
 */
import { compareVersions } from '@shared/version';

export { cliVersionStatus, compareVersions, type CliVersionStatus } from '@shared/version';

/** A reported version, or null when it is missing/blank (the normalizer sends '' without one). */
export function knownVersion(version: string | null): string | null {
  if (version === null) return null;
  const trimmed = version.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * WP-62: the tested version (`ClaudeInstallStatus.testedVersion`, from the CLI profile of the
 * server's build) when the installed `version` is newer than it, else null – a quiet hint, never an
 * error (a newer CLI stays supported, C.7). Same rule as the server's `isNewerThanTested`.
 */
export function newerThanTested(claude: { version: string | null; testedVersion: string | null }): string | null {
  const version = knownVersion(claude.version);
  const tested = knownVersion(claude.testedVersion);
  if (version === null || tested === null) return null;
  return (compareVersions(version, tested) ?? 0) > 0 ? tested : null;
}
