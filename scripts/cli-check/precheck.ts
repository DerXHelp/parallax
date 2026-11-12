/**
 * Step 1 of `pnpm cli-check` (WP-62): the checks before any live call, without cost – the same
 * guards as the recorder and the live smoke (ADR-011): no `ANTHROPIC_API_KEY`/`_AUTH_TOKEN`/
 * `_BASE_URL`, `claude auth status` = claude.ai login with `firstParty`, the CLI not older than the
 * SDK expects (C.7). The facts come from the real profile check of "Standard"
 * (`ClaudeIntegration.checkProfile`: resolveClaude + `claude --version` + `auth status --json` with
 * buildEnv), so the check sees the `claude` Parallax would start. Pure rating, tested.
 */
import type { ClaudeInstallStatus } from '@shared/model';

/** Variables that would bill the API instead of the subscription (ADR-011). */
export const API_BILLING_VARS: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

/** Names of billing variables set in `env` (case-insensitive, non-empty). */
export function billingVarsSet(env: Readonly<Record<string, string | undefined>>): string[] {
  const wanted = new Set(API_BILLING_VARS);
  return Object.entries(env)
    .filter(([key, value]) => wanted.has(key.toUpperCase()) && (value ?? '') !== '')
    .map(([key]) => key)
    .sort();
}

/** Reasons that forbid a live call (empty = go). */
export function precheckProblems(input: {
  env: Readonly<Record<string, string | undefined>>;
  status: ClaudeInstallStatus;
  sdkVersion: string | null;
}): string[] {
  const problems: string[] = [];
  const billing = billingVarsSet(input.env);
  if (billing.length > 0) problems.push(`${billing.join(', ')} set – only the subscription login is allowed`);
  if (input.sdkVersion === null) problems.push('Agent SDK not installed (pnpm install --frozen-lockfile)');
  const { status } = input;
  if (status.state !== 'ok' || status.path === null) {
    problems.push(`claude not usable: ${status.state} ${status.error?.code ?? ''}`.trim());
    return problems;
  }
  if (status.versionStatus === 'too_old') problems.push(`claude ${status.version ?? '?'} is older than the SDK expects`);
  if (status.versionStatus === 'unknown') problems.push('claude version unknown or not comparable with the SDK requirement');
  const auth = status.auth;
  if (auth.state !== 'logged_in') problems.push(`claude auth status: ${auth.state}`);
  else if (auth.method !== 'claude.ai' || auth.apiProvider !== 'firstParty') {
    problems.push(`claude auth status: ${auth.method ?? '?'}/${auth.apiProvider ?? '?'} – subscription login (claude.ai/firstParty) required`);
  }
  return problems;
}
