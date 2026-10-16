/**
 * `pnpm preflight` – environment check (WP-11). English output, exit code 0 = ok (warnings
 * allowed), 1 = at least one failure, 2 = the check itself crashed.
 *
 * Checks (docs/plan.md "Paketmanager: pnpm 12", "Claude-Profile"): Node version (fail < 22, warn
 * if not 26), pnpm version, registry (`pnpm config get registry`), Agent SDK, for every profile
 * the resolved `claude` path + version (C.7) and the login (`claude auth status --json`, only
 * method/provider/subscription – never e-mail or organization), Microsoft Edge, and whether other
 * users can read the data folder (R2-13; `--home=<dir>` / PARALLAX_HOME like the server, default
 * %LOCALAPPDATA%\Parallax). The profiles are those of the data folder's `profiles.json`, read
 * without writing anything (WP-32; missing or newer file → only "Standard"), each with its
 * findings (profileIssues). Only `claude --version` and `claude auth status` are run – no model
 * call, no tokens.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createClaudeIntegration } from '../src/server/claude/integration';
import { formatPreflight, loadPreflightProfiles, runPreflight } from '../src/server/claude/preflight';
import { profileIssues } from '../src/server/claude/profileIssues';
import { defaultProfileIssueContext } from '../src/server/claude/profileStore';
import { createProfileStore } from '../src/server/claude/profiles';
import { readSdkManifest } from '../src/server/claude/resolveClaude';
import { loadConfig } from '../src/server/config';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function appVersion(): string {
  const text = readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
  return z.looseObject({ version: z.string().min(1) }).parse(JSON.parse(text) as unknown).version;
}

/** The data folder the server would use (same rules as the server); null if the arguments are invalid. */
function dataHome(): string | null {
  try {
    return loadConfig({ argv: process.argv.slice(2) }).home;
  } catch (error) {
    process.stderr.write(
      `preflight: data folder not checked (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return null;
  }
}

async function main(): Promise<number> {
  const sdk = await readSdkManifest();
  const home = dataHome();
  const { profiles, source } = await loadPreflightProfiles(home);
  const integration = createClaudeIntegration({
    appVersion: appVersion(),
    sdkClaudeCodeVersion: sdk?.claudeCodeVersion ?? null,
    profiles: createProfileStore(profiles),
  });
  const issueContext = defaultProfileIssueContext();
  const report = await runPreflight({
    integration,
    nodeVersion: process.version,
    env: process.env,
    cwd: repoRoot,
    nodeExecutable: process.execPath,
    sdk,
    home,
    profilesSource: source,
    profileIssues: (profile) => profileIssues(profile, issueContext),
  });
  process.stdout.write(formatPreflight(report.checks));
  return report.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`preflight: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
