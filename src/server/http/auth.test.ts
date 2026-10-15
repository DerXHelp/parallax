import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_CODE_TTL_MS, authCookieName, bearerAuthorization } from '@shared/http';
import { SAMPLE_IDS } from '@shared/samples';
import { createStoreWarnings } from '../store/jsonStore';
import { makeTempHome } from './testServer';
import { AUTH_SECRET_FILE, MAX_PENDING_CODES, authCookieHeader, createAuthService, readCookie } from './auth';

async function service(options: { home?: string; now?: () => number } = {}) {
  const home = options.home ?? (await makeTempHome('auth-'));
  const auth = await createAuthService({
    home,
    serverInstanceId: SAMPLE_IDS.serverInstanceId,
    now: options.now,
  });
  return { home, auth };
}

describe('one-time codes', () => {
  it('are single use', async () => {
    const { auth } = await service();
    const issued = auth.issueAuthCode();
    expect(issued.serverInstanceId).toBe(SAMPLE_IDS.serverInstanceId);
    expect(auth.exchangeCode(issued.code)).toBe(true);
    expect(auth.exchangeCode(issued.code)).toBe(false);
  });

  it('expire after the TTL (60 s by default)', async () => {
    let t = 1_000_000;
    const { auth } = await service({ now: () => t });
    const issued = auth.issueAuthCode();
    expect(Date.parse(issued.expiresAt) - 1_000_000).toBe(AUTH_CODE_TTL_MS);
    t += AUTH_CODE_TTL_MS;
    expect(auth.exchangeCode(issued.code)).toBe(false);
    const custom = auth.issueAuthCode(10 * 60_000);
    t += 9 * 60_000;
    expect(auth.exchangeCode(custom.code)).toBe(true);
  });

  it('reject unknown and malformed codes and cap the pending list', async () => {
    const { auth } = await service();
    expect(auth.exchangeCode('x'.repeat(43))).toBe(false);
    expect(auth.exchangeCode('short')).toBe(false);
    const first = auth.issueAuthCode();
    for (let i = 0; i < MAX_PENDING_CODES; i++) auth.issueAuthCode();
    expect(auth.exchangeCode(first.code)).toBe(false);
  });
});

describe('device cookie', () => {
  it('round-trips and survives a restart with the persisted secret', async () => {
    const { home, auth } = await service();
    const value = auth.createCookieValue();
    expect(auth.verifyCookieValue(value)).toBe(true);
    expect(auth.isAuthenticated(`other=1; ${authCookieName(4711)}=${value}`, 4711)).toBe(true);
    expect(auth.isAuthenticated(`${authCookieName(4712)}=${value}`, 4711)).toBe(false);
    await auth.close();

    const restarted = await createAuthService({ home, serverInstanceId: SAMPLE_IDS.serverInstanceId });
    expect(restarted.verifyCookieValue(value)).toBe(true);
    const file = JSON.parse(await readFile(path.join(home, AUTH_SECRET_FILE), 'utf8')) as { secret: string };
    expect(file.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects tampered, foreign and expired cookies', async () => {
    let t = Date.parse('2026-10-15T08:00:00.000Z');
    const { auth } = await service({ now: () => t });
    const other = await service();
    const value = auth.createCookieValue();
    const [version, device, issued, mac] = value.split('.');
    expect(
      auth.verifyCookieValue(`${version ?? ''}.${device ?? ''}.${String(Number(issued) + 1)}.${mac ?? ''}`),
    ).toBe(false);
    expect(auth.verifyCookieValue(`${value}x`)).toBe(false);
    expect(auth.verifyCookieValue(other.auth.createCookieValue())).toBe(false);
    expect(auth.verifyCookieValue(undefined)).toBe(false);
    expect(auth.verifyCookieValue('')).toBe(false);
    t += 401 * 24 * 60 * 60 * 1000;
    expect(auth.verifyCookieValue(value)).toBe(false);
  });

  it('is revoked by rotating the secret (listeners notified)', async () => {
    const { auth } = await service();
    const value = auth.createCookieValue();
    let revoked = 0;
    const off = auth.onRevoked(() => {
      revoked += 1;
    });
    await auth.rotateSecret();
    expect(auth.verifyCookieValue(value)).toBe(false);
    expect(auth.verifyCookieValue(auth.createCookieValue())).toBe(true);
    expect(revoked).toBe(1);
    off();
    await auth.rotateSecret();
    expect(revoked).toBe(1);
  });

  it('keeps no backup of the secret: a rotated secret can never come back from a .bak (R1-11)', async () => {
    const home = await makeTempHome('auth-');
    // A .bak left by an older build is removed at start.
    await writeFile(
      path.join(home, `${AUTH_SECRET_FILE}.bak`),
      JSON.stringify({ schemaVersion: 1, secret: 'B'.repeat(43), createdAt: '2026-10-15T08:00:00.000Z' }),
      'utf8',
    );
    const auth = await createAuthService({ home, serverInstanceId: SAMPLE_IDS.serverInstanceId });
    expect(await readdir(home)).toEqual([AUTH_SECRET_FILE]);
    const before = auth.createCookieValue();
    await auth.rotateSecret();
    await auth.rotateSecret();
    expect(await readdir(home)).toEqual([AUTH_SECRET_FILE]);
    await auth.close();
    // Corrupt main file after the rotation: no backup to restore the old secret from.
    await writeFile(path.join(home, AUTH_SECRET_FILE), '{broken', 'utf8');
    const restarted = await createAuthService({ home, serverInstanceId: SAMPLE_IDS.serverInstanceId });
    expect(restarted.verifyCookieValue(before)).toBe(false);
  });

  it('builds the Set-Cookie header from the contract attributes and parses Cookie headers', () => {
    expect(authCookieHeader(4711, 'v')).toBe(
      'parallax_4711=v; Max-Age=34560000; Path=/; HttpOnly; SameSite=Strict',
    );
    expect(readCookie('a=1; parallax_4711=abc.def; b=2', 'parallax_4711')).toBe('abc.def');
    expect(readCookie('parallax_47110=x', 'parallax_4711')).toBeUndefined();
  });

  it('quarantines a corrupt secret file and starts with a new secret', async () => {
    const home = await makeTempHome('auth-');
    await writeFile(path.join(home, AUTH_SECRET_FILE), '{broken', 'utf8');
    const warnings = createStoreWarnings();
    const auth = await createAuthService({ home, serverInstanceId: SAMPLE_IDS.serverInstanceId, warnings });
    expect(auth.verifyCookieValue(auth.createCookieValue())).toBe(true);
    expect(warnings.list()[0]?.error.code).toBe('STORE_CORRUPT_QUARANTINED');
    expect((await readdir(home)).some((name) => name.startsWith(`${AUTH_SECRET_FILE}.corrupt-`))).toBe(true);
  });
});

describe('launcher token', () => {
  it('accepts only the exact bearer token', async () => {
    const { auth } = await service();
    expect(auth.launcherToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.verifyLauncherToken(bearerAuthorization(auth.launcherToken))).toBe(true);
    expect(auth.verifyLauncherToken(`bearer ${auth.launcherToken}`)).toBe(true);
    expect(auth.verifyLauncherToken(undefined)).toBe(false);
    expect(auth.verifyLauncherToken(auth.launcherToken)).toBe(false);
    expect(auth.verifyLauncherToken(bearerAuthorization('A'.repeat(43)))).toBe(false);
  });
});
