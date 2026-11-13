/**
 * WP-70: the fake login process – the CLI's OAuth flow without a browser or account. The links
 * point to a reserved, unreachable host (`login.parallax.invalid`). A pasted code finishes the flow:
 * `fake-refused` → refused (LOGIN_FAILED {reason:'code'}), `fake-expired` → expired, anything else
 * → signed in with `subscriptionType` (default `max`). Tests finish or fail the flow through the
 * handle (`complete`, `fail`) – like the redirect to the CLI's localhost listener.
 */
import { makeError, type ErrorPayload } from '@shared/errors';
import type { LoginRequest, LoginResult, LoginSession, LoginStartResult } from '../types';

export const FAKE_LOGIN_HOST = 'https://login.parallax.invalid';
/** Pasted codes with a fixed outcome (E2E, dev). */
export const FAKE_LOGIN_REFUSED_CODE = 'fake-refused';
export const FAKE_LOGIN_EXPIRED_CODE = 'fake-expired';

export interface FakeLoginOptions {
  /** Answer of authenticate(): 'ok' (default), or LOGIN_UNAVAILABLE / LOGIN_BLOCKED. */
  start?: 'ok' | 'unavailable' | 'blocked';
  /** true = also an `automaticUrl` (the flow then finishes through `complete()`); default false. */
  automatic?: boolean;
  /** Plan reported on success; default 'max'. */
  subscriptionType?: string | null;
}

export interface FakeLoginHandle {
  readonly req: LoginRequest;
  readonly pid: number;
  /** The `state` of the current flow (null before authenticate or after the end). */
  readonly flowState: string | null;
  /** Codes passed to submitCode (assertions). */
  readonly codes: readonly { code: string; state: string }[];
  readonly closed: boolean;
  /** Test: the browser redirect reached the CLI – the flow ends signed in. */
  complete(subscriptionType?: string | null): void;
  /** Test: the flow ends with this error (e.g. LOGIN_BLOCKED for an org pin). */
  fail(error: ErrorPayload): void;
  /** Test: the process ends (what the login service's cancel/dispose does, or a crash). */
  close(): Promise<void>;
}

export class FakeLoginSession implements LoginSession, FakeLoginHandle {
  readonly exited: Promise<void>;
  readonly codes: { code: string; state: string }[] = [];
  closed = false;
  private flow: { state: string; done: PromiseWithResolvers<LoginResult> } | null = null;
  private flows = 0;
  private readonly exit = Promise.withResolvers<undefined>();

  constructor(
    readonly req: LoginRequest,
    readonly pid: number,
    private readonly options: () => FakeLoginOptions,
  ) {
    this.exited = this.exit.promise;
  }

  get flowState(): string | null {
    return this.flow?.state ?? null;
  }

  authenticate(): Promise<LoginStartResult> {
    if (this.closed) return Promise.resolve({ ok: false, error: makeError('LOGIN_FAILED', { reason: 'process' }) });
    const o = this.options();
    if (o.start === 'unavailable') return Promise.resolve({ ok: false, error: makeError('LOGIN_UNAVAILABLE') });
    if (o.start === 'blocked') return Promise.resolve({ ok: false, error: makeError('LOGIN_BLOCKED') });
    // Like the CLI: a second attempt joins the open flow (same links).
    if (this.flow === null) {
      this.flows += 1;
      this.flow = { state: `fake-state-${String(this.pid)}-${String(this.flows)}`, done: Promise.withResolvers() };
    }
    const state = this.flow.state;
    const manualUrl = `${FAKE_LOGIN_HOST}/oauth/authorize?code=true&state=${state}`;
    const automaticUrl = o.automatic === true ? `${FAKE_LOGIN_HOST}/oauth/authorize?state=${state}&port=0` : null;
    return Promise.resolve({ ok: true, manualUrl, automaticUrl });
  }

  submitCode(code: string, state: string): Promise<LoginResult> {
    this.codes.push({ code, state });
    const flow = this.flow;
    if (flow === null) return Promise.resolve({ ok: false, error: makeError('LOGIN_FAILED', { reason: 'expired' }) });
    if (code === FAKE_LOGIN_EXPIRED_CODE) this.end({ ok: false, error: makeError('LOGIN_FAILED', { reason: 'expired' }) });
    else if (code === FAKE_LOGIN_REFUSED_CODE || state !== flow.state) {
      this.end({ ok: false, error: makeError('LOGIN_FAILED', { reason: 'code' }) });
    } else this.end({ ok: true, subscriptionType: this.subscription(undefined) });
    return flow.done.promise;
  }

  waitForCompletion(): Promise<LoginResult> {
    const flow = this.flow;
    if (flow === null) return Promise.resolve({ ok: false, error: makeError('LOGIN_FAILED', { reason: 'expired' }) });
    return flow.done.promise;
  }

  complete(subscriptionType?: string | null): void {
    this.end({ ok: true, subscriptionType: this.subscription(subscriptionType) });
  }

  fail(error: ErrorPayload): void {
    this.end({ ok: false, error });
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.end({ ok: false, error: makeError('LOGIN_FAILED', { reason: 'process' }) });
      this.exit.resolve(undefined);
    }
    return this.exited;
  }

  private subscription(given: string | null | undefined): string | null {
    if (given !== undefined) return given;
    const configured = this.options().subscriptionType;
    return configured === undefined ? 'max' : configured;
  }

  /** The CLI clears the flow in `finally`: every end (also a refused code) needs a new start. */
  private end(result: LoginResult): void {
    const flow = this.flow;
    if (flow === null) return;
    this.flow = null;
    flow.done.resolve(result);
  }
}
