import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UPDATE_RESULT_FILE, consumeUpdateResult, writeUpdateResult, type UpdateResult } from './marker';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp87-marker-'));
  temps.push(dir);
  return dir;
}

const AT = '2026-11-17T12:00:00.000Z';
const OLD = { version: '1.0.0', buildId: '1.0.0+aaa' };
const NEW = { version: '1.0.1', buildId: '1.0.1+bbb' };

function result(p: Partial<UpdateResult>): UpdateResult {
  return {
    schemaVersion: 1,
    outcome: 'pending',
    from: OLD,
    to: NEW,
    at: AT,
    backupDir: null,
    error: null,
    log: null,
    ...p,
  };
}

async function gone(dir: string): Promise<boolean> {
  return access(path.join(dir, UPDATE_RESULT_FILE)).then(
    () => false,
    () => true,
  );
}

describe('update-result.json (WP-87 §1.7, E3)', () => {
  it('pending or installed for this build → justUpdated, and the marker is gone', async () => {
    const dir = await home();
    await writeUpdateResult(dir, result({}));
    expect(await consumeUpdateResult(dir, NEW)).toEqual({
      justUpdated: { from: '1.0.0', to: '1.0.1', at: AT },
      failedUpdate: null,
    });
    expect(await gone(dir)).toBe(true);
    await writeUpdateResult(dir, result({ outcome: 'installed', from: { version: null, buildId: null } }));
    expect((await consumeUpdateResult(dir, NEW)).justUpdated).toEqual({ from: null, to: '1.0.1', at: AT });
  });

  it('failed whose from is this build → failedUpdate (with a default error)', async () => {
    const dir = await home();
    await writeUpdateResult(dir, result({ outcome: 'failed', log: 'D:\\h\\logs\\update-1.log' }));
    expect(await consumeUpdateResult(dir, OLD)).toEqual({
      justUpdated: null,
      failedUpdate: {
        version: '1.0.1',
        restoredTo: '1.0.0',
        at: AT,
        error: { code: 'UPDATE_RESTART_FAILED', params: { version: '1.0.1', reason: 'exited' } },
        log: 'D:\\h\\logs\\update-1.log',
      },
    });
  });

  it('stale, broken or missing markers give nothing and are removed', async () => {
    const dir = await home();
    expect(await consumeUpdateResult(dir, NEW)).toEqual({ justUpdated: null, failedUpdate: null });
    await writeUpdateResult(dir, result({}));
    expect(await consumeUpdateResult(dir, OLD)).toEqual({ justUpdated: null, failedUpdate: null });
    expect(await gone(dir)).toBe(true);
    await writeUpdateResult(dir, result({ outcome: 'failed' }));
    expect(await consumeUpdateResult(dir, NEW)).toEqual({ justUpdated: null, failedUpdate: null });
    await writeFile(path.join(dir, UPDATE_RESULT_FILE), '{"schemaVersion": 2}');
    expect(await consumeUpdateResult(dir, NEW)).toEqual({ justUpdated: null, failedUpdate: null });
    expect(await gone(dir)).toBe(true);
  });

  it('a newer writer may add fields (additive changes stay readable)', async () => {
    const dir = await home();
    await writeFile(path.join(dir, UPDATE_RESULT_FILE), JSON.stringify({ ...result({}), extra: { x: 1 } }));
    expect((await consumeUpdateResult(dir, NEW)).justUpdated?.to).toBe('1.0.1');
  });
});
