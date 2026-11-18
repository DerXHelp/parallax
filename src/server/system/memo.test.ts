import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import {
  EMPTY_SYSTEM_MEMO,
  SYSTEM_MEMO_FILE,
  fileMemo,
  fileState,
  fingerprint,
  memoryMemo,
  systemMemo,
} from './memo';

const log = pino({ level: 'silent' });

describe('system integration memo (ADR-229)', () => {
  it('round-trips through <home>/system-integration.json; garbage or another version reads as empty', async () => {
    const home = await makeTempHome('sys-memo-');
    const memo = fileMemo(home, log);
    expect(await memo.read()).toEqual(EMPTY_SYSTEM_MEMO);
    const data = {
      autostart: fingerprint('a'),
      protocol: null,
      registered: true,
      startMenu: fingerprint({ x: 1 }),
    };
    await memo.write(data);
    expect(await fileMemo(home, log).read()).toEqual(data);
    await writeFile(path.join(home, SYSTEM_MEMO_FILE), '{"schemaVersion":2}');
    expect(await memo.read()).toEqual(EMPTY_SYSTEM_MEMO);
    await writeFile(path.join(home, SYSTEM_MEMO_FILE), 'not json');
    expect(await memo.read()).toEqual(EMPTY_SYSTEM_MEMO);
    await writeFile(path.join(home, SYSTEM_MEMO_FILE), '{"schemaVersion":1,"autostart":"x"}');
    expect(await memo.read()).toEqual(EMPTY_SYSTEM_MEMO);
  });

  it('fingerprints are stable; fileState is a plain stat (size and time, or absent)', async () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint('x')).toMatch(/^[0-9a-f]{64}$/u);
    const home = await makeTempHome('sys-memo-');
    const file = path.join(home, 'Parallax.lnk');
    expect(await fileState(file)).toBe('absent');
    await writeFile(file, 'lnk');
    expect(await fileState(file)).toMatch(/^3:\d+$/u);
  });

  it('a test run without an injected memo keeps it in memory – never the file in the home', async () => {
    const home = await makeTempHome('sys-memo-');
    const memo = systemMemo(undefined, home, log);
    await memo.write({ ...EMPTY_SYSTEM_MEMO, registered: true });
    expect((await memo.read()).registered).toBe(true);
    expect(existsSync(path.join(home, SYSTEM_MEMO_FILE))).toBe(false);
    const injected = memoryMemo();
    expect(systemMemo(injected, home, log)).toBe(injected);
  });
});
