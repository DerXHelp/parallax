import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import {
  REDACTED,
  createLogger,
  initLogging,
  logger,
  redactText,
  registerSecret,
  unregisterSecret,
} from './logger';

function memoryLogger() {
  const lines: string[] = [];
  const log = createLogger({ level: 'info', destination: { write: (line: string) => lines.push(line) } });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { log, lines, parsed };
}

describe('logger redaction', () => {
  it('masks env values but keeps the variable names', () => {
    const { log, parsed } = memoryLogger();
    log.info({ env: { ANTHROPIC_API_KEY: 'sk-ant-abcdefghijkl', PATH: 'C:\\bin' } }, 'spawn');
    log.info({ spawn: { env: { SECRET_THING: 'v' } } }, 'nested');
    expect(parsed()[0]?.env).toEqual({ ANTHROPIC_API_KEY: REDACTED, PATH: REDACTED });
    expect(parsed()[1]?.spawn).toEqual({ env: { SECRET_THING: REDACTED } });
  });

  it('masks tokens, cookies and authorization headers by key', () => {
    const { log, lines } = memoryLogger();
    log.info(
      {
        launcherToken: 'tok-123456789',
        headers: { cookie: 'parallax_4711=abc', authorization: 'Bearer secret-value-1' },
        req: { headers: { authorization: 'Bearer secret-value-2' } },
        secret: 's3cr3t-value',
      },
      'request',
    );
    const out = lines.join('');
    for (const value of ['tok-123456789', 'abc', 'secret-value-1', 'secret-value-2', 's3cr3t-value']) {
      expect(out).not.toContain(value);
    }
    // Error codes stay readable (no redaction of `code`).
    log.warn({ error: { code: 'AUTH_REQUIRED' } }, 'rejected');
    expect(lines.at(-1)).toContain('AUTH_REQUIRED');
  });

  it('scrubs registered secrets and token patterns from free text', () => {
    const { log, lines } = memoryLogger();
    registerSecret('very-secret-launcher-token');
    log.info(`token is very-secret-launcher-token, Authorization: Bearer abcdefghijklmnop`);
    log.info('stderr: ANTHROPIC_AUTH_TOKEN=xyz123456 MY_SECRET=hunter2hunter2 sk-ant-api03-ABCDEFGHIJ');
    log.info('Cookie: parallax_4712=v1.abc.def.ghi; other=1');
    unregisterSecret('very-secret-launcher-token');
    const out = lines.join('');
    for (const value of [
      'very-secret-launcher-token',
      'abcdefghijklmnop',
      'xyz123456',
      'hunter2hunter2',
      'sk-ant-api03',
      'v1.abc.def.ghi',
    ]) {
      expect(out).not.toContain(value);
    }
    expect(out).toContain('other=1');
    expect(redactText('plain text stays')).toBe('plain text stays');
  });

  it('scrubs token-like JSON keys at any depth and inside escaped strings (R1-20)', () => {
    const { log, lines } = memoryLogger();
    log.info({ a: { b: { c: { GITHUB_TOKEN: 'ghp_deep_secret_1', note: 'kept' } } } }, 'deep');
    log.info({ x: { y: { z: { env: { PATH: 'C:\\deep-env-value' } } } } }, 'deep env');
    log.info('payload {"API_KEY":"escaped_secret_2","client_secret":"escaped_secret_3"}');
    log.info({ usage: { inputTokens: 12, maxTokens: 200_000 } }, 'numbers stay');
    const out = lines.join('');
    for (const value of ['ghp_deep_secret_1', 'deep-env-value', 'escaped_secret_2', 'escaped_secret_3']) {
      expect(out).not.toContain(value);
    }
    expect(out).toContain('kept');
    expect(out).toContain('"inputTokens":12');
    expect(redactText('{"maxTokens":"1000","refreshToken":"abc"}')).toBe(
      `{"maxTokens":"1000","refreshToken":"${REDACTED}"}`,
    );
  });

  it('keeps the dev login URL readable (codes are only logged in dev mode, by design)', () => {
    const url = 'http://127.0.0.1:5173/#code=tok0000000000000000000000000000000000000001';
    expect(redactText(url)).toBe(url);
  });
});

describe('initLogging', () => {
  it('writes the singleton logger into a rotating file under PARALLAX_HOME/logs', async () => {
    const home = await makeTempHome('logging-');
    const handle = await initLogging({ home, dev: false, level: 'info', console: false });
    try {
      logger.info({ env: { KEY: 'value-to-hide' } }, 'hello file');
    } finally {
      await handle.close();
    }
    logger.level = 'silent';
    const dir = path.join(home, 'logs');
    const files = await readdir(dir);
    expect(files.length).toBeGreaterThan(0);
    const content = (await Promise.all(files.map((file) => readFile(path.join(dir, file), 'utf8')))).join('');
    expect(content).toContain('hello file');
    expect(content).not.toContain('value-to-hide');
    expect(handle.logFile).toBe(path.join(home, 'logs', 'parallax.log'));
    // pino-roll pulls in date-fns: the first import can be slow on Windows (virus scanner).
  }, 30_000);
});
