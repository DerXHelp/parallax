/**
 * `pnpm preflight` – environment check (WP-11). English output, exit code 0 = ok (warnings
 * allowed), 1 = at least one failure, 2 = the check itself crashed.
 *
 * Checks (docs/plan.md "Paketmanager: pnpm 12", "Claude-Profile"): Node version (fail < 22, warn
 * if not 26), pnpm version, registry (`pnpm config get registry`), Agent SDK, for every profile
 * the resolved `claude` path + version (C.7) and the login (`claude auth status --json`, only
 * method/provider/subscription – never e-mail or organization), Microsoft Edge.
 * Only `claude --version` and `claude auth status` are run – no model call, no tokens.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createClaudeIntegration } from '../src/server/claude/integration';
import { formatPreflight, runPreflight } from '../src/server/claude/preflight';
import { readSdkManifest } from '../src/server/claude/resolveClaude';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function appVersion(): string {
  const text = readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
  return z.looseObject({ version: z.string().min(1) }).parse(JSON.parse(text) as unknown).version;
}

async function main(): Promise<number> {
  const sdk = await readSdkManifest();
  const integration = createClaudeIntegration({
    appVersion: appVersion(),
    sdkClaudeCodeVersion: sdk?.claudeCodeVersion ?? null,
  });
  const report = await runPreflight({
    integration,
    nodeVersion: process.version,
    env: process.env,
    cwd: repoRoot,
    nodeExecutable: process.execPath,
    sdk,
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
