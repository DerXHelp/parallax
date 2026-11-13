/**
 * WP-70: login of a profile through the CLI's OAuth flow – internal SDK methods of 0.3.322 (not in
 * `sdk.d.ts`, checked at runtime like ADR-170): `claudeAuthenticate(loginWithClaudeAi)` →
 * `claude_authenticate` → `{manualUrl, automaticUrl}` (the CLI never opens a browser itself),
 * `claudeOAuthCallback(code, state)` and `claudeOAuthWaitForCompletion()` – both answer when the
 * flow ended, with `{account: {email, organization, subscriptionType, …}}`.
 *
 * Privacy: only `account.subscriptionType` leaves this module. Neither the answers nor the CLI's
 * error texts are logged (they may name the account); errors are classified into codes instead.
 */
import type { Logger } from 'pino';
import { z } from 'zod';
import { makeError, type ErrorPayload } from '@shared/errors';
import { isHttpUrl } from '@shared/model';
import type { BackendEvent, LoginResult, LoginSession, LoginStartResult } from './types';

/** The internal login methods of the SDK `Query` (optional: a missing one is LOGIN_UNAVAILABLE). */
export interface LoginQueryMethods {
  claudeAuthenticate?(loginWithClaudeAi: boolean): Promise<unknown>;
  claudeOAuthCallback?(authorizationCode: string, state: string): Promise<unknown>;
  claudeOAuthWaitForCompletion?(): Promise<unknown>;
}

/** Names of the login methods (the cli-check probe checks that they exist, never calls them). */
export const LOGIN_METHODS = [
  'claudeAuthenticate',
  'claudeOAuthCallback',
  'claudeOAuthWaitForCompletion',
] as const satisfies readonly (keyof LoginQueryMethods)[];

/** True when every login method exists on the handle (never calls one). */
export function hasLoginMethods(q: object): boolean {
  return LOGIN_METHODS.every((name) => typeof Reflect.get(q, name) === 'function');
}

/** Thrown inside a control call when the handle lacks the method (→ LOGIN_UNAVAILABLE). */
export class LoginMethodMissing extends Error {
  constructor(method: string) {
    super(`${method} missing`);
    this.name = 'LoginMethodMissing';
  }
}

/** Thrown by `withTimeout` callers' label check: the flow waited past its bound. */
export const LOGIN_TIMEOUT_NAME = 'TimeoutError';

const startAnswerSchema = z.object({
  manualUrl: z.string(),
  automaticUrl: z.string().nullish(),
});

/** Only the plan – zod drops every other key (e-mail, organization, token source …). */
const completionAnswerSchema = z.object({
  account: z
    .object({ subscriptionType: z.string().max(40).nullish().catch(null) })
    .nullish()
    .catch(null),
});

function httpsUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !isHttpUrl(value)) return null;
  return value.toLowerCase().startsWith('https://') ? value : null;
}

/** The answer of `claudeAuthenticate`: both links https, else LOGIN_FAILED {reason:'url'}. */
export function loginStartOf(raw: unknown): LoginStartResult {
  const parsed = startAnswerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: makeError('LOGIN_UNAVAILABLE', { detail: 'answer' }) };
  const manualUrl = httpsUrl(parsed.data.manualUrl);
  if (manualUrl === null) return { ok: false, error: makeError('LOGIN_FAILED', { reason: 'url' }) };
  return { ok: true, manualUrl, automaticUrl: httpsUrl(parsed.data.automaticUrl) };
}

/** The answer of the callback/wait request: only `subscriptionType`. */
export function loginResultOf(raw: unknown): LoginResult {
  const parsed = completionAnswerSchema.safeParse(raw);
  if (!parsed.success) return { ok: true, subscriptionType: null };
  return { ok: true, subscriptionType: parsed.data.account?.subscriptionType ?? null };
}

export type LoginStep = 'start' | 'code' | 'wait';

const BLOCKED = /login blocked|managed settings|forceLoginMethod|allowedProviders/i;
const NO_FLOW = /no active claude_authenticate flow/i;
const UNSUPPORTED = /unsupported control request|unknown control request|unknown subtype|not supported in this/i;
const CLOSED = /session closed|backend disposed|process exited|terminated/i;

/**
 * Classifies a failed login request (the CLI's text is read here and nowhere else): a missing
 * method or unknown request → LOGIN_UNAVAILABLE; managed settings → LOGIN_BLOCKED; no flow / timed
 * out → LOGIN_FAILED {reason:'expired'}; process gone → 'process'; a refused code → 'code'.
 */
export function loginErrorOf(error: unknown, step: LoginStep): ErrorPayload {
  if (error instanceof LoginMethodMissing) return makeError('LOGIN_UNAVAILABLE', { detail: 'method' });
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const name = error instanceof Error ? error.name : '';
  if (UNSUPPORTED.test(message)) return makeError('LOGIN_UNAVAILABLE', { detail: 'request' });
  if (BLOCKED.test(message)) return makeError('LOGIN_BLOCKED');
  if (NO_FLOW.test(message)) return makeError('LOGIN_FAILED', { reason: 'expired' });
  if (name === LOGIN_TIMEOUT_NAME) return makeError('LOGIN_FAILED', { reason: step === 'start' ? 'failed' : 'expired' });
  if (CLOSED.test(message)) return makeError('LOGIN_FAILED', { reason: 'process' });
  return makeError('LOGIN_FAILED', { reason: step === 'code' ? 'code' : 'failed' });
}

/** What the login wrapper needs from the backend's process (SdkSession in login mode). */
export interface LoginProcess {
  readonly pid: number | null;
  readonly events: AsyncIterable<BackendEvent>;
  control<T>(label: string, ms: number, call: (q: LoginQueryMethods) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface LoginTimeouts {
  /** `claudeAuthenticate` (may wait for the CLI's initialize: cold start). */
  loginStartMs: number;
  /** `claudeOAuthCallback` (token exchange and profile fetch). */
  loginCodeMs: number;
  /** `claudeOAuthWaitForCompletion` (the user signs in in the browser). */
  loginFlowMs: number;
}

/** LoginSession over a backend process: never rejects, never logs answers or CLI texts. */
export function createLoginSession(proc: LoginProcess, timeouts: LoginTimeouts, log: Logger): LoginSession {
  const exited = (async () => {
    try {
      for await (const event of proc.events) {
        if (event.type === 'exit') break;
      }
    } catch {
      // The queue never throws; nothing to report.
    }
  })();

  const fail = (error: unknown, step: LoginStep): { ok: false; error: ErrorPayload } => {
    const payload = loginErrorOf(error, step);
    log.info({ step, code: payload.code, reason: payload.params.reason ?? null }, 'login request failed');
    return { ok: false, error: payload };
  };

  return {
    get pid() {
      return proc.pid;
    },
    exited,
    async authenticate() {
      try {
        const raw = await proc.control('claudeAuthenticate', timeouts.loginStartMs, (q) => {
          if (typeof q.claudeAuthenticate !== 'function') throw new LoginMethodMissing('claudeAuthenticate');
          return q.claudeAuthenticate(true);
        });
        const result = loginStartOf(raw);
        if (!result.ok) log.info({ code: result.error.code }, 'login start answer not usable');
        return result;
      } catch (error) {
        return fail(error, 'start');
      }
    },
    async submitCode(code, state) {
      try {
        const raw = await proc.control('claudeOAuthCallback', timeouts.loginCodeMs, (q) => {
          if (typeof q.claudeOAuthCallback !== 'function') throw new LoginMethodMissing('claudeOAuthCallback');
          return q.claudeOAuthCallback(code, state);
        });
        return loginResultOf(raw);
      } catch (error) {
        return fail(error, 'code');
      }
    },
    async waitForCompletion() {
      try {
        const raw = await proc.control('claudeOAuthWaitForCompletion', timeouts.loginFlowMs, (q) => {
          if (typeof q.claudeOAuthWaitForCompletion !== 'function') {
            throw new LoginMethodMissing('claudeOAuthWaitForCompletion');
          }
          return q.claudeOAuthWaitForCompletion();
        });
        return loginResultOf(raw);
      } catch (error) {
        return fail(error, 'wait');
      }
    },
    close: () => proc.close(),
  };
}
