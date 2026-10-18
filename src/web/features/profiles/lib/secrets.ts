/**
 * Env names whose values the editor hides behind the eye button (Plan "Claude-Profile": `*_KEY`,
 * `*_TOKEN`, `*_SECRET`; plus anything with `PASSWORD`, case-insensitive). Same rule as the
 * server's `isSecretEnvKey` (src/server/claude/profiles.ts, which redacts them from the logs) –
 * the web cannot import server code; keep both in step.
 */
export function isSecretEnvKey(name: string): boolean {
  return /(?:_KEY|_TOKEN|_SECRET)$/i.test(name) || /PASSWORD/i.test(name);
}
