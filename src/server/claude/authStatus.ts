/**
 * `claude auth status --json` (F.17). Format (CLI 2.1.300, exit 0 when logged in):
 *   { "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
 *     "subscriptionType": "max", "email": …, "orgId": …, "orgName": …,
 *     "configDirectory": …, "projectsDirectory": …, "analyticsDisabled": false }
 * The contract view (`ClaudeInstallStatus['auth']`) never contains e-mail or organization; only
 * the fixture recorder reads those (to replace them in recordings) via parseRawAuthStatus().
 */
import { z } from 'zod';
import type { ClaudeInstallStatus } from '@shared/model';

export type AuthStatusView = ClaudeInstallStatus['auth'];

/** Raw output, tolerant (unknown fields kept, all optional except `loggedIn`). */
export const rawAuthStatusSchema = z.looseObject({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
  subscriptionType: z.string().nullable().optional(),
  /** Personal data: never log, persist or send (F.17). */
  email: z.string().nullable().optional(),
  orgId: z.string().nullable().optional(),
  orgName: z.string().nullable().optional(),
  configDirectory: z.string().optional(),
  projectsDirectory: z.string().optional(),
});
export type RawAuthStatus = z.infer<typeof rawAuthStatusSchema>;

const MAX_FIELD_CHARS = 100;

/** JSON text or an already parsed value. */
function toJson(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

/** The raw object (including e-mail/org) or null if it is not auth-status JSON. Recorder only. */
export function parseRawAuthStatus(input: unknown): RawAuthStatus | null {
  const parsed = rawAuthStatusSchema.safeParse(toJson(input));
  return parsed.success ? parsed.data : null;
}

function field(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_FIELD_CHARS);
}

/**
 * Contract view of `claude auth status --json` (stdout text or parsed JSON): `logged_in` /
 * `logged_out` from `loggedIn`, `error` if the output is not the expected JSON. Method, provider
 * and subscription type are passed through as given (open sets); e-mail and org are dropped.
 */
export function parseAuthStatus(input: unknown): AuthStatusView {
  const raw = parseRawAuthStatus(input);
  if (raw === null) return { state: 'error', method: null, apiProvider: null, subscriptionType: null };
  return {
    state: raw.loggedIn ? 'logged_in' : 'logged_out',
    method: field(raw.authMethod),
    apiProvider: field(raw.apiProvider),
    subscriptionType: field(raw.subscriptionType),
  };
}

/** Before the first check. */
export const UNKNOWN_AUTH: AuthStatusView = {
  state: 'unknown',
  method: null,
  apiProvider: null,
  subscriptionType: null,
};
