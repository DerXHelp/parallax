/**
 * CLI profile (WP-62): what `pnpm cli-check` observed for the `claude` version last checked with
 * Parallax – the one source in the repo (`cli-profile.json`, written only by
 * `pnpm cli-check --accept`, sorted lists, diff-friendly). The server reads `testedVersion` from it
 * (`ClaudeInstallStatus.testedVersion`: the UI hints when the installed CLI is newer); the check
 * compares a new observation with it (`scripts/cli-check/compare.ts`).
 *
 * The JSON is bundled at build time (esbuild/Vite/tsx import): an accepted profile reaches the
 * production instance with the next `git pull` + rebuild (the file is a build input, ADR-065).
 */
import { z } from 'zod';
import { compareVersions } from '@shared/version';
import { logger } from '../lib/logger';
import bundledProfile from './cli-profile.json' with { type: 'json' };

export const CLI_PROFILE_SCHEMA_VERSION = 1;

/** Repo-relative path of the profile (for the check script and messages). */
export const CLI_PROFILE_PATH = 'src/server/claude/cli-profile.json';

const list = z.array(z.string());

export const cliProfileSchema = z.object({
  schemaVersion: z.literal(CLI_PROFILE_SCHEMA_VERSION),
  /** `claude --version` of the accepted check. */
  cliVersion: z.string().min(1),
  /** Installed `@anthropic-ai/claude-agent-sdk` of the accepted check. */
  sdkVersion: z.string().min(1),
  /** ISO date-time of the accepted check. */
  checkedAt: z.string().min(1),
  /** `system/init.model` of the probe (Haiku). */
  model: z.string(),
  /** `system/init.permissionMode` without a mode in the options (the CLI default, WP22-04). */
  permissionMode: z.string(),
  /** `system/init.output_style`. */
  outputStyle: z.string(),
  /** Keys of `system/init`. */
  initKeys: list,
  /** `system/init.tools` without `mcp__*` (deferred tools included). */
  tools: list,
  /** `getContextUsage('full').deferredBuiltinTools[].name`; null = the CLI did not report them. */
  deferredTools: list.nullable(),
  /** `system/init.capabilities`. */
  capabilities: list,
  /** Keys of `initializationResult()` (never values: `account` holds e-mail/org). */
  initializationKeys: list,
  /** `supportedModels()[].value`. */
  models: list,
  /** `getContextUsage().categories[].id`. */
  contextCategories: list,
  /** `system/init.slash_commands` (settings isolated: built-in commands and bundled skills). */
  slashCommands: list,
  /** `system/init.agents`. */
  agents: list,
  /** `system/init.skills`. */
  skills: list,
  /**
   * WP-64: Remote Control worked in the probe (`enableRemoteControl` answer schema + `bridge_state
   * connected` within 15 s); null = not checked (profile older than WP-64).
   */
  remoteControl: z.boolean().nullable().default(null),
  /**
   * WP-65: the internal `Query.generateSessionTitle` answered a usable title (auto title, „Titel neu
   * erzeugen“); null = not checked (profile older than WP-65).
   */
  sessionTitle: z.boolean().nullable().default(null),
  /**
   * WP-65: the experimental usage query answered a `rate_limits` object with `utilization`/`resets_at`
   * windows (limit bar without a rate-limit event); null = not checked.
   */
  usageQuery: z.boolean().nullable().default(null),
  /** WP-65: `Query.backgroundTasks` exists („In den Hintergrund“, never called); null = not checked. */
  backgroundTasks: z.boolean().nullable().default(null),
  /**
   * WP-66: the internal `Query.askSideQuestion` answered `{response: string, synthetic: boolean}` with a
   * model answer and no `canUseTool` call (side questions, `/btw`); null = not checked.
   */
  sideQuestion: z.boolean().nullable().default(null),
  /** WP-66: `Query.cancelAsyncMessage` exists („Zurückholen“, never called); null = not checked. */
  withdrawQueued: z.boolean().nullable().default(null),
});
export type CliProfile = z.infer<typeof cliProfileSchema>;

/** The profile bundled with this build, or null when the file does not match the schema. */
export function parseCliProfile(raw: unknown): CliProfile | null {
  const parsed = cliProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

let cached: { profile: CliProfile | null } | undefined;

/** The bundled profile (parsed once); an invalid file is logged once and yields null. */
export function bundledCliProfile(): CliProfile | null {
  if (cached === undefined) {
    const profile = parseCliProfile(bundledProfile);
    if (profile === null) logger.warn({ file: CLI_PROFILE_PATH }, 'cli profile invalid – testedVersion unknown');
    cached = { profile };
  }
  return cached.profile;
}

/** `testedVersion` for every ClaudeInstallStatus of this server (null = no valid profile). */
export function testedCliVersion(): string | null {
  return bundledCliProfile()?.cliVersion ?? null;
}

/**
 * True when the installed `version` is newer than `tested` (both known and parsable). Same rule as
 * the web hint (`web/lib/version.ts` `newerThanTested`); a newer CLI stays supported (C.7).
 */
export function isNewerThanTested(version: string | null, tested: string | null): boolean {
  if (version === null || tested === null) return false;
  return (compareVersions(version, tested) ?? 0) > 0;
}
