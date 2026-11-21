/**
 * `pnpm preflight` – environment check (WP-11). English output, exit code 0 = ok (warnings
 * allowed), 1 = at least one failure, 2 = the check itself crashed.
 *
 * Checks (docs/plan.md "Paketmanager: pnpm 12", "Claude-Profile"): Node version (fail < 22, warn
 * if not 26), pnpm version, registry (`pnpm config get registry`), Agent SDK, for every profile
 * the resolved `claude` path + version (C.7) and the login (`claude auth status --json`, only
 * method/provider/subscription – never e-mail or organization), Google Chrome (path and version
 * from its version resource – chrome.exe is never started) with the Chrome policies that override
 * the app window (ADR-136), and where the data folder lies (R2-13, a hint only – no rights query,
 * ADR-229; `--home=<dir>` / PARALLAX_HOME like the server, default %LOCALAPPDATA%\Parallax). The profiles are those of the data folder's `profiles.json`, read
 * without writing anything (WP-32; missing or newer file → only "Standard"), each with its
 * findings (profileIssues). Only `claude --version` and `claude auth status` are run – no model
 * call, no tokens. Then "Several computers" (WP-82, remote/preflight.ts): TLS self-test, Windows key
 * store and – for the role "Share" – port and addresses (the firewall only as a reminder), read-only
 * like the rest.
 *
 * Both platforms (WP-108): the archiver of in-app updates and the installer (`System32\tar.exe`,
 * Linux `/usr/bin/tar`); Linux also the OpenSSL of this Node ("Several computers" needs 3.5, the
 * official build brings it). The key store line names the Windows store until the server mode adds
 * the Linux one (WP-107).
 */
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createClaudeIntegration } from '../src/server/claude/integration';
import {
  formatPreflight,
  loadPreflightProfiles,
  preflightExitCode,
  runPreflight,
  type PreflightCheck,
} from '../src/server/claude/preflight';
import { profileIssues } from '../src/server/claude/profileIssues';
import { defaultProfileIssueContext } from '../src/server/claude/profileStore';
import { createProfileStore } from '../src/server/claude/profiles';
import { readSdkManifest } from '../src/server/claude/resolveClaude';
import { loadConfig } from '../src/server/config';
import { opensslNote } from '../src/server/install/cli';
import { createLogger } from '../src/server/lib/logger';
import { listenerAddresses } from '../src/server/remote/addresses';
import { probePort } from '../src/server/remote/checks';
import { multiHostPreflight } from '../src/server/remote/preflight';
import { createDpapiKeyStore } from '../src/server/secure/keyStore';
import { tlsSelfTest } from '../src/server/secure/selfTest';
import { archiveTool } from '../src/server/update/zip';

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

/** The archiver of in-app updates and of the installer's SDK step (WP-108). */
function archiverCheck(): PreflightCheck {
  const tool = archiveTool().file;
  try {
    accessSync(tool, constants.X_OK);
    return { id: 'archiver', title: 'tar', level: 'ok', detail: tool };
  } catch {
    return {
      id: 'archiver',
      title: 'tar',
      level: 'warn',
      detail: `${tool} is missing`,
      hint: 'In-app updates and the installer unpack with it.',
    };
  }
}

/** Linux: the OpenSSL of this Node ("Several computers" needs 3.5 or newer). */
function opensslCheck(): PreflightCheck[] {
  if (process.platform === 'win32') return [];
  const version = process.versions.openssl;
  const note = opensslNote(version);
  return [
    note === null
      ? { id: 'openssl', title: 'openssl', level: 'ok', detail: version }
      : { id: 'openssl', title: 'openssl', level: 'warn', detail: version, hint: note },
  ];
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
  const keyStore = createDpapiKeyStore({ logger: createLogger({ level: 'silent' }) });
  const multiHost = await multiHostPreflight({
    home,
    selfTest: () => tlsSelfTest(),
    keyStoreAvailable: () => keyStore.available(),
    addresses: (bindAddress) => listenerAddresses(bindAddress),
    probe: probePort,
  });
  const checks = [...report.checks, archiverCheck(), ...opensslCheck(), ...multiHost];
  process.stdout.write(formatPreflight(checks));
  return Math.max(report.exitCode, preflightExitCode(checks));
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
