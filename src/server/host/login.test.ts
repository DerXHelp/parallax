import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import { profileLoginSchema } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import {
  createFakeBackend,
  FAKE_LOGIN_HOST,
  FAKE_LOGIN_REFUSED_CODE,
  type FakeBackend,
  type FakeLoginOptions,
} from '../backend/fakeBackend';
import { createFakeClaudeIntegration } from '../backend/fake/integration';
import type { LoginSession } from '../backend/types';
import { CommandError } from '../sync/ports';
import { createLoginService, parseLoginCode, type LoginService, type LoginServiceDeps } from './login';

const ctx = { clientId: SAMPLE_IDS.client, cmdId: SAMPLE_IDS.cmdId };
const CWD = 'C:\\parallax-test\\login';

interface Setup {
  service: LoginService;
  backend: FakeBackend;
  opened: string[];
  changes: () => number;
  loggedIn: string[];
  checks: string[];
}

const services: LoginService[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) await service.dispose();
});

function setup(
  o: { login?: FakeLoginOptions; deps?: Partial<LoginServiceDeps>; openFails?: boolean } = {},
): Setup {
  const backend = createFakeBackend(o.login === undefined ? {} : { login: o.login });
  const claude = createFakeClaudeIntegration();
  const checks: string[] = [];
  const check = claude.checkProfile.bind(claude);
  const opened: string[] = [];
  const loggedIn: string[] = [];
  let changes = 0;
  const service = createLoginService({
    claude: {
      profiles: claude.profiles,
      launchSpecFor: (profileId, entryId) => claude.launchSpecFor(profileId, entryId),
      checkProfile: (profileId) => {
        checks.push(profileId);
        return check(profileId);
      },
    },
    backend,
    links: {
      open: (url) => {
        opened.push(url);
        return o.openFails === true
          ? Promise.reject(new CommandError(makeError('OPEN_FAILED', { reason: 'test' })))
          : Promise.resolve();
      },
    },
    cwd: CWD,
    ensureDir: () => Promise.resolve(),
    onChange: () => {
      changes += 1;
    },
    onLoggedIn: (profileId) => {
      loggedIn.push(profileId);
    },
    ...o.deps,
  });
  services.push(service);
  return { service, backend, opened, changes: () => changes, loggedIn, checks };
}

async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(predicate()).toBe(true);
  });
}

function login(s: Setup): Promise<unknown> {
  return s.service.handle({ name: 'profile.login', profileId: STANDARD_PROFILE_ID }, ctx);
}

describe('parseLoginCode (WP-70)', () => {
  const manual = 'https://claude.ai/oauth/authorize?code=true&client_id=x&state=st4te';

  it('takes code#state, a link with code/state, or the bare code with the state of the manual link', () => {
    expect(parseLoginCode('  abc_DEF-123#st4te \n', manual)).toEqual({ code: 'abc_DEF-123', state: 'st4te' });
    expect(
      parseLoginCode('https://console.anthropic.com/oauth/code/callback?code=abc&state=xyz', manual),
    ).toEqual({
      code: 'abc',
      state: 'xyz',
    });
    expect(parseLoginCode('abc123', manual)).toEqual({ code: 'abc123', state: 'st4te' });
    expect(parseLoginCode('abc123#', manual)).toEqual({ code: 'abc123', state: 'st4te' });
  });

  it('refuses whitespace inside, an empty code and a missing state', () => {
    expect(parseLoginCode('abc 123#s', manual)).toBeNull();
    expect(parseLoginCode('#s', manual)).toBeNull();
    expect(parseLoginCode('abc123', null)).toBeNull();
    expect(parseLoginCode('https://x.invalid/cb?state=s', manual)).toBeNull();
  });
});

describe('createLoginService (WP-70)', () => {
  it('starts one login process per profile without PARALLAX_ENTRY_ID, opens the link and waits', async () => {
    const s = setup();
    expect(s.service.names).toEqual(['profile.login', 'profile.loginCode', 'profile.loginCancel']);
    expect(await login(s)).toEqual({});
    expect(s.service.state(STANDARD_PROFILE_ID).state).toBe('starting');
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'waiting');
    const state = s.service.state(STANDARD_PROFILE_ID);
    expect(state.url?.startsWith(FAKE_LOGIN_HOST)).toBe(true);
    expect(state.manualUrl).toBe(state.url);
    expect(profileLoginSchema.parse(state)).toEqual(state);
    expect(s.opened).toEqual([state.url]);
    const [process] = s.backend.logins;
    expect(process?.req.cwd).toBe(CWD);
    expect(
      Object.keys(process?.req.launch.env ?? {}).some((k) => k.toUpperCase() === 'PARALLAX_ENTRY_ID'),
    ).toBe(false);
    // A second click keeps the process and shows the link again.
    await login(s);
    expect(s.backend.logins).toHaveLength(1);
    await until(() => s.opened.length === 2);
  });

  it('a pasted code#state signs in: done with the plan only, auth status read again, engine told', async () => {
    const s = setup();
    await login(s);
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'waiting');
    const flowState = s.backend.logins[0]?.flowState ?? '';
    await s.service.handle(
      { name: 'profile.loginCode', profileId: STANDARD_PROFILE_ID, code: `c0de#${flowState}` },
      ctx,
    );
    await until(() => s.loggedIn.length === 1);
    const state = s.service.state(STANDARD_PROFILE_ID);
    expect(state).toMatchObject({ state: 'done', subscriptionType: 'max', url: null, error: null });
    expect(JSON.stringify(state)).not.toMatch(/@|organization|email/i);
    expect(s.checks).toEqual([STANDARD_PROFILE_ID]);
    expect(s.backend.logins[0]?.closed).toBe(true);
    expect(s.backend.logins[0]?.codes).toEqual([{ code: 'c0de', state: flowState }]);
  });

  it('the redirect to the CLI (automatic link) finishes without a code', async () => {
    const s = setup({ login: { automatic: true, subscriptionType: 'pro' } });
    await login(s);
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'waiting');
    expect(s.service.state(STANDARD_PROFILE_ID).url).toContain('port=0');
    s.backend.logins[0]?.complete();
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'done');
    expect(s.service.state(STANDARD_PROFILE_ID).subscriptionType).toBe('pro');
  });

  it('a refused code fails the flow (LOGIN_FAILED code); a new login starts a new process', async () => {
    const s = setup();
    await login(s);
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'waiting');
    const flowState = s.backend.logins[0]?.flowState ?? '';
    await s.service.handle(
      {
        name: 'profile.loginCode',
        profileId: STANDARD_PROFILE_ID,
        code: `${FAKE_LOGIN_REFUSED_CODE}#${flowState}`,
      },
      ctx,
    );
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'failed');
    expect(s.service.state(STANDARD_PROFILE_ID).error).toEqual(makeError('LOGIN_FAILED', { reason: 'code' }));
    expect(s.loggedIn).toEqual([]);
    await login(s);
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'waiting');
    expect(s.backend.logins).toHaveLength(2);
  });

  it('managed settings block and a missing method are states, not command errors', async () => {
    const blocked = setup({ login: { start: 'blocked' } });
    await login(blocked);
    await until(() => blocked.service.state(STANDARD_PROFILE_ID).state === 'failed');
    expect(blocked.service.state(STANDARD_PROFILE_ID).error?.code).toBe('LOGIN_BLOCKED');
    expect(blocked.opened).toEqual([]);
    const unavailable = setup({ login: { start: 'unavailable' } });
    await login(unavailable);
    await until(() => unavailable.service.state(STANDARD_PROFILE_ID).state === 'failed');
    expect(unavailable.service.state(STANDARD_PROFILE_ID).error?.code).toBe('LOGIN_UNAVAILABLE');
  });

  it('code without a waiting login → LOGIN_FAILED expired; unusable code → VALIDATION_FAILED; unknown profile', async () => {
    const s = setup();
    await expect(
      s.service.handle({ name: 'profile.loginCode', profileId: STANDARD_PROFILE_ID, code: 'x#y' }, ctx),
    ).rejects.toMatchObject({ error: { code: 'LOGIN_FAILED', params: { reason: 'expired' } } });
    await login(s);
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'waiting');
    await expect(
      s.service.handle({ name: 'profile.loginCode', profileId: STANDARD_PROFILE_ID, code: 'a b' }, ctx),
    ).rejects.toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    await expect(
      s.service.handle({ name: 'profile.login', profileId: 'pf_00000000000000000000000000000099' }, ctx),
    ).rejects.toMatchObject({ error: { code: 'PROFILE_NOT_FOUND' } });
  });

  it('cancel closes the process and returns to idle; a link that cannot open keeps waiting', async () => {
    const s = setup({ openFails: true });
    await login(s);
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'waiting');
    expect(s.opened).toHaveLength(1);
    await s.service.handle({ name: 'profile.loginCancel', profileId: STANDARD_PROFILE_ID }, ctx);
    expect(s.service.state(STANDARD_PROFILE_ID).state).toBe('idle');
    expect(s.backend.logins[0]?.closed).toBe(true);
    // Cancel without a login is a no-op.
    await s.service.handle({ name: 'profile.loginCancel', profileId: STANDARD_PROFILE_ID }, ctx);
  });

  it('after flowMs the login expires and the process closes; a process that ends fails the login', async () => {
    const s = setup({ deps: { flowMs: 50 } });
    await login(s);
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'failed');
    expect(s.service.state(STANDARD_PROFILE_ID).error).toEqual(
      makeError('LOGIN_FAILED', { reason: 'expired' }),
    );
    expect(s.backend.logins[0]?.closed).toBe(true);

    const t = setup();
    await login(t);
    await until(() => t.service.state(STANDARD_PROFILE_ID).state === 'waiting');
    await t.backend.logins[0]?.close();
    await until(() => t.service.state(STANDARD_PROFILE_ID).state === 'failed');
    expect(t.service.state(STANDARD_PROFILE_ID).error?.params).toEqual({ reason: 'process' });
  });

  it('a launch error (claude missing) is the failed state with that code', async () => {
    const s = setup({
      deps: {
        claude: {
          profiles: createFakeClaudeIntegration().profiles,
          launchSpecFor: () => Promise.reject(new CommandError(makeError('CLAUDE_NOT_FOUND'))),
          checkProfile: () => Promise.reject(new Error('unused')),
        },
      },
    });
    await login(s);
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'failed');
    expect(s.service.state(STANDARD_PROFILE_ID).error?.code).toBe('CLAUDE_NOT_FOUND');
  });

  it('dispose closes open login processes; later commands are refused', async () => {
    const sessions: LoginSession[] = [];
    const backend = createFakeBackend();
    const s = setup({
      deps: {
        backend: {
          startLogin: (req) => {
            const session = backend.startLogin(req);
            sessions.push(session);
            return session;
          },
        },
      },
    });
    await login(s);
    await until(() => s.service.state(STANDARD_PROFILE_ID).state === 'waiting');
    await s.service.dispose();
    expect(backend.logins[0]?.closed).toBe(true);
    await expect(login(s)).rejects.toMatchObject({ error: { code: 'SERVER_SHUTTING_DOWN' } });
    expect(s.changes()).toBeGreaterThan(0);
  });
});
