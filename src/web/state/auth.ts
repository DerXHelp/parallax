import {
  API_PATHS,
  authStatusResponseSchema,
  takeAuthCodeFromHash,
  type AuthCode,
  type AuthExchangeRequest,
  type AuthStatusResponse,
} from '@shared/http';

/**
 * Client side of the auth bootstrap (architecture §5.1 "Client-Ablauf", A.8, ADR-015):
 * 1. `#code=` is taken out of the hash and removed from the URL at once (`history.replaceState`).
 * 2. With a code: `POST /api/auth {code}`; a 401 is remembered, the flow continues.
 * 3. `GET /api/auth/status` before every WS attempt: not signed in → no WS; network error →
 *    "unreachable" (the connection retries with backoff).
 * The device cookie is HttpOnly – the page never sees it.
 */

export type AuthCheckResult =
  | { kind: 'authenticated'; serverInstanceId: string }
  /** `codeRejected`: the code from the URL was refused (AUTH_CODE_INVALID). */
  | { kind: 'unauthenticated'; codeRejected: boolean }
  | { kind: 'unreachable' };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LocationLike {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

export interface HistoryLike {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/**
 * Step 1: returns the code (null if absent/malformed) and removes every `code=` part from the URL
 * (also a malformed one); the rest of the hash (`#session=…`) stays.
 */
export function consumeAuthCode(location: LocationLike, history: HistoryLike): AuthCode | null {
  const { code, hash } = takeAuthCodeFromHash(location.hash);
  if (hash !== location.hash) {
    history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
  }
  return code;
}

export type AuthExchangeOutcome = 'ok' | 'rejected' | 'unreachable';

/** Step 2: `POST /api/auth`. Any HTTP error counts as rejected, a network error as unreachable. */
export async function exchangeAuthCode(code: AuthCode, fetchFn: FetchLike): Promise<AuthExchangeOutcome> {
  const body: AuthExchangeRequest = { code };
  try {
    const response = await fetchFn(API_PATHS.auth, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return response.ok ? 'ok' : 'rejected';
  } catch {
    return 'unreachable';
  }
}

/** Step 3: `GET /api/auth/status`; null if the server is unreachable or answers nonsense. */
export async function fetchAuthStatus(fetchFn: FetchLike): Promise<AuthStatusResponse | null> {
  try {
    const response = await fetchFn(API_PATHS.authStatus, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    const parsed = authStatusResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface AuthBootstrap {
  /** Steps 2 + 3; called by the connection before every WS attempt (step 5: again after close 1006). */
  check(): Promise<AuthCheckResult>;
  readonly codeRejected: boolean;
}

/**
 * The code is exchanged once (kept while the server is unreachable, it may still be valid); later
 * checks only ask the status.
 */
export function createAuthBootstrap(options: { code: AuthCode | null; fetch: FetchLike }): AuthBootstrap {
  let pendingCode = options.code;
  let codeRejected = false;
  return {
    async check() {
      if (pendingCode !== null) {
        const outcome = await exchangeAuthCode(pendingCode, options.fetch);
        if (outcome === 'unreachable') return { kind: 'unreachable' };
        pendingCode = null;
        codeRejected = outcome === 'rejected';
      }
      const status = await fetchAuthStatus(options.fetch);
      if (status === null) return { kind: 'unreachable' };
      if (!status.authenticated) return { kind: 'unauthenticated', codeRejected };
      return { kind: 'authenticated', serverInstanceId: status.serverInstanceId };
    },
    get codeRejected() {
      return codeRejected;
    },
  };
}
