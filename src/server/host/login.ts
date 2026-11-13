/**
 * WP-70: login of a profile from Parallax – host commands `profile.login`, `profile.loginCode`,
 * `profile.loginCancel` and the state `ProfileSummary.login` (merged into the host state by the
 * engine). Per profile at most one short-lived login process (`AgentBackend.startLogin`): the
 * profile's launch spec (env through buildEnv, config folder; no PARALLAX_ENTRY_ID), a neutral cwd
 * in the Parallax home, no prompt, no transcript. Flow:
 *
 *   starting → claudeAuthenticate → waiting (the link opens in the default browser through the
 *   LinkOpener of `link.open`; recording only with the FakeBackend) → claudeOAuthWaitForCompletion
 *   in the background; a pasted code → verifying → claudeOAuthCallback → done | failed.
 *
 * The process closes after success, failure, cancel or `flowMs` (10 min, the CLI's own bound).
 * After success the profile's auth status is read again (`checkProfile`) and the engine retries a
 * Remote Control bridge that failed for the sign-in (`onLoggedIn`). Never logs, stores or sends the
 * account's e-mail or organization (the backend passes only `subscriptionType`), nor the pasted code.
 */
import { mkdir } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { ProfileId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import { IDLE_PROFILE_LOGIN, type ProfileLogin } from '@shared/model';
import type { CommandOf, CommandResult, HostCommand } from '@shared/protocol';
import type { AgentBackend, LoginResult, LoginSession } from '../backend/types';
import { deleteEnvVar } from '../claude/env';
import type { ClaudeIntegration } from '../claude/ports';
import { toError } from '../lib/async';
import { logger as rootLogger } from '../lib/logger';
import { CommandError, type HostCommandHandler } from '../sync/ports';
import type { LinkOpener } from './linkCommands';

/** Working directory of login processes below PARALLAX_HOME (empty; the CLI writes nothing there). */
export const LOGIN_HOME_DIR = 'login';
/** The CLI keeps an OAuth flow 10 min; Parallax closes the process then. */
export const LOGIN_FLOW_MS = 10 * 60_000;
/** Placeholder entry id for the launch spec (removed from the env again: no entry behind it). */
const LOGIN_ENTRY_ID = 'login';
/** dispose(): how long a running auth-status check after a login may take. */
const DISPOSE_WAIT_MS = 5_000;

export interface LoginServiceDeps {
  claude: Pick<ClaudeIntegration, 'launchSpecFor' | 'checkProfile' | 'profiles'>;
  backend: Pick<AgentBackend, 'startLogin'>;
  /** The opener of `link.open` (system browser; recording with the FakeBackend). */
  links: LinkOpener;
  /** Neutral working directory of login processes (created on demand), e.g. `<home>\login`. */
  cwd: string;
  /** The host state changed (a login state or the profile's auth status). */
  onChange(): void;
  /** A profile signed in (after the auth status was read again). */
  onLoggedIn?(profileId: ProfileId): void;
  now?: () => Date;
  logger?: Logger;
  flowMs?: number;
  ensureDir?: (dir: string) => Promise<void>;
}

export interface LoginService extends HostCommandHandler {
  /** The profile's login state (idle when none ran since the server start). */
  state(profileId: ProfileId): ProfileLogin;
  /** Server shutdown: every login process closed, timers cleared. */
  dispose(): Promise<void>;
}

interface Flow {
  readonly generation: number;
  session: LoginSession | null;
  manualUrl: string | null;
  timer: NodeJS.Timeout | null;
}

/** URL-safe token of an OAuth code or state (base64url, hex, …) – never whitespace. */
const TOKEN = /^[A-Za-z0-9._~+/=-]{1,2000}$/;

function stateOfUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).searchParams.get('state');
  } catch {
    return null;
  }
}

/**
 * The pasted text of the sign-in page → code and state: `code#state` (what the page shows), a link
 * with `code` (and `state`) parameters, or the bare code (state from the manual link). Null when no
 * usable pair comes out.
 */
export function parseLoginCode(
  input: string,
  manualUrl: string | null,
): { code: string; state: string } | null {
  const text = input.trim();
  let code: string | null = null;
  let state: string | null = null;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
      code = url.searchParams.get('code') ?? hash.get('code');
      state = url.searchParams.get('state') ?? hash.get('state');
    } catch {
      return null;
    }
  } else {
    const at = text.indexOf('#');
    if (at >= 0) {
      code = text.slice(0, at);
      state = text.slice(at + 1);
    } else {
      code = text;
    }
  }
  state = state === null || state === '' ? stateOfUrl(manualUrl) : state;
  if (code === null || state === null || !TOKEN.test(code) || !TOKEN.test(state)) return null;
  return { code, state };
}

export function createLoginService(deps: LoginServiceDeps): LoginService {
  const log = (deps.logger ?? rootLogger).child({ module: 'host/login' });
  const now = deps.now ?? (() => new Date());
  const flowMs = deps.flowMs ?? LOGIN_FLOW_MS;
  const ensureDir =
    deps.ensureDir ??
    (async (dir: string) => {
      await mkdir(dir, { recursive: true });
    });
  const states = new Map<ProfileId, ProfileLogin>();
  const flows = new Map<ProfileId, Flow>();
  const pending = new Set<Promise<unknown>>();
  let generations = 0;
  let disposed = false;

  const track = (promise: Promise<unknown>): void => {
    const tracked = promise
      .catch((error: unknown) => {
        log.warn({ err: error }, 'login task failed');
      })
      .finally(() => {
        pending.delete(tracked);
      });
    pending.add(tracked);
  };

  const state = (profileId: ProfileId): ProfileLogin => states.get(profileId) ?? IDLE_PROFILE_LOGIN;

  const setState = (profileId: ProfileId, next: Omit<ProfileLogin, 'at'>): void => {
    states.set(profileId, { ...next, at: now().toISOString() });
    deps.onChange();
  };

  const current = (profileId: ProfileId, generation: number): Flow | null => {
    const flow = flows.get(profileId);
    return flow?.generation === generation && !disposed ? flow : null;
  };

  /** Ends the flow (process closed, timer cleared); the state is set by the caller. */
  const endFlow = (profileId: ProfileId, flow: Flow): void => {
    if (flows.get(profileId) === flow) flows.delete(profileId);
    if (flow.timer !== null) clearTimeout(flow.timer);
    flow.timer = null;
    const session = flow.session;
    flow.session = null;
    if (session !== null) track(session.close());
  };

  const fail = (profileId: ProfileId, generation: number, error: ErrorPayload): void => {
    const flow = current(profileId, generation);
    if (flow === null) return;
    log.info({ profileId, code: error.code, reason: error.params.reason ?? null }, 'login failed');
    endFlow(profileId, flow);
    setState(profileId, { ...IDLE_PROFILE_LOGIN, state: 'failed', error });
  };

  const succeed = (profileId: ProfileId, generation: number, subscriptionType: string | null): void => {
    const flow = current(profileId, generation);
    if (flow === null) return;
    log.info({ profileId, subscriptionType }, 'login done');
    endFlow(profileId, flow);
    setState(profileId, { ...IDLE_PROFILE_LOGIN, state: 'done', subscriptionType });
    track(
      (async () => {
        try {
          await deps.claude.checkProfile(profileId);
        } catch (error) {
          log.warn({ err: error, profileId }, 'auth status after the login could not be read');
        }
        if (disposed) return;
        deps.onChange();
        deps.onLoggedIn?.(profileId);
      })(),
    );
  };

  const finish = (profileId: ProfileId, generation: number, result: LoginResult): void => {
    if (result.ok) succeed(profileId, generation, result.subscriptionType);
    else fail(profileId, generation, result.error);
  };

  const openLink = async (url: string): Promise<void> => {
    try {
      await deps.links.open(url);
    } catch (error) {
      // The dialog offers "open again" and "copy link"; the URL itself is not logged.
      const code = error instanceof CommandError ? error.error.code : 'OPEN_FAILED';
      log.warn({ code }, 'login link could not be opened in the default browser');
    }
  };

  const begin = async (profileId: ProfileId, generation: number): Promise<void> => {
    let session: LoginSession;
    try {
      await ensureDir(deps.cwd);
      const launch = await deps.claude.launchSpecFor(profileId, LOGIN_ENTRY_ID);
      const env = { ...launch.env };
      deleteEnvVar(env, 'PARALLAX_ENTRY_ID');
      const flow = current(profileId, generation);
      if (flow === null) return;
      session = deps.backend.startLogin({ launch: { ...launch, env }, cwd: deps.cwd });
      flow.session = session;
    } catch (error) {
      const payload =
        error instanceof CommandError ? error.error : makeError('LOGIN_FAILED', { reason: 'process' });
      if (!(error instanceof CommandError))
        log.warn({ err: error, profileId }, 'login process could not be started');
      fail(profileId, generation, payload);
      return;
    }
    log.info({ profileId, pid: session.pid }, 'login process started');
    track(
      session.exited.then(() => {
        const flow = current(profileId, generation);
        if (flow?.session === session)
          fail(profileId, generation, makeError('LOGIN_FAILED', { reason: 'process' }));
      }),
    );
    const start = await session.authenticate();
    const flow = current(profileId, generation);
    if (flow === null) return;
    if (!start.ok) {
      fail(profileId, generation, start.error);
      return;
    }
    const url = start.automaticUrl ?? start.manualUrl;
    flow.manualUrl = start.manualUrl;
    flow.timer = setTimeout(() => {
      fail(profileId, generation, makeError('LOGIN_FAILED', { reason: 'expired' }));
    }, flowMs);
    flow.timer.unref();
    setState(profileId, { ...IDLE_PROFILE_LOGIN, state: 'waiting', url, manualUrl: start.manualUrl });
    log.info({ profileId, automatic: start.automaticUrl !== null }, 'login waiting for the browser');
    await openLink(url);
    const result = await session.waitForCompletion();
    // A pasted code is being checked: its own answer decides (same end, a more precise reason).
    if (state(profileId).state === 'verifying' && current(profileId, generation) !== null) return;
    finish(profileId, generation, result);
  };

  const login = (cmd: CommandOf<'profile.login'>): CommandResult<'profile.login'> => {
    const profileId = cmd.profileId;
    if (deps.claude.profiles.get(profileId) === undefined) {
      throw new CommandError(makeError('PROFILE_NOT_FOUND', { profileId }));
    }
    const running = flows.get(profileId);
    if (running !== undefined) {
      // One process per profile: a second click keeps it (and shows the link again).
      const shown = state(profileId);
      if (shown.state === 'waiting' && shown.url !== null) track(openLink(shown.url));
      return {};
    }
    generations += 1;
    const flow: Flow = { generation: generations, session: null, manualUrl: null, timer: null };
    flows.set(profileId, flow);
    setState(profileId, { ...IDLE_PROFILE_LOGIN, state: 'starting' });
    track(begin(profileId, flow.generation));
    return {};
  };

  const loginCode = (cmd: CommandOf<'profile.loginCode'>): CommandResult<'profile.loginCode'> => {
    const profileId = cmd.profileId;
    const flow = flows.get(profileId);
    const session = flow?.session ?? null;
    if (flow === undefined || session === null || state(profileId).state !== 'waiting') {
      throw new CommandError(makeError('LOGIN_FAILED', { reason: 'expired' }));
    }
    const parsed = parseLoginCode(cmd.code, flow.manualUrl);
    if (parsed === null) throw new CommandError(makeError('VALIDATION_FAILED', { field: 'code' }));
    const waiting = state(profileId);
    setState(profileId, { ...waiting, state: 'verifying', error: null });
    const generation = flow.generation;
    track(
      session.submitCode(parsed.code, parsed.state).then((result) => {
        finish(profileId, generation, result);
      }),
    );
    return {};
  };

  const cancel = (cmd: CommandOf<'profile.loginCancel'>): CommandResult<'profile.loginCancel'> => {
    const flow = flows.get(cmd.profileId);
    if (flow !== undefined) {
      log.info({ profileId: cmd.profileId }, 'login cancelled');
      endFlow(cmd.profileId, flow);
    }
    if (state(cmd.profileId).state !== 'idle') setState(cmd.profileId, { ...IDLE_PROFILE_LOGIN });
    return {};
  };

  const dispatch = (cmd: HostCommand): unknown => {
    if (disposed) throw new CommandError(makeError('SERVER_SHUTTING_DOWN'));
    switch (cmd.name) {
      case 'profile.login':
        return login(cmd);
      case 'profile.loginCode':
        return loginCode(cmd);
      case 'profile.loginCancel':
        return cancel(cmd);
      default:
        throw new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }));
    }
  };

  return {
    names: ['profile.login', 'profile.loginCode', 'profile.loginCancel'],
    handle(cmd: HostCommand): Promise<unknown> {
      try {
        return Promise.resolve(dispatch(cmd));
      } catch (error) {
        return Promise.reject(toError(error));
      }
    },
    state,
    async dispose() {
      disposed = true;
      for (const [profileId, flow] of [...flows]) endFlow(profileId, flow);
      const all = Promise.allSettled([...pending]);
      await Promise.race([all, new Promise((resolve) => setTimeout(resolve, DISPOSE_WAIT_MS).unref())]);
    },
  };
}
