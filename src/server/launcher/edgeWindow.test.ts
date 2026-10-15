import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appUrlWithCode, serverOrigin } from '@shared/http';
import { sampleToken } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import type { SpawnHiddenOptions } from '../lib/process';
import {
  EDGE_DISABLED_FEATURES,
  edgeAppArgs,
  edgeProfileDir,
  edgeProfileSignedIn,
  openEdgeWindow,
  type SpawnFn,
  type SpawnedChild,
} from './edgeWindow';

const HOME = 'C:\\Users\\Jane Doe\\AppData\\Local\\Parallax';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

interface SpawnCall {
  file: string;
  args: readonly string[];
  options: SpawnHiddenOptions;
}

/** A child stand-in that reports `spawn` (or an error) on the next tick. */
function fakeSpawn(outcome: 'spawn' | Error) {
  const calls: SpawnCall[] = [];
  const counters = { unrefs: 0 };
  const spawn: SpawnFn = (file, args, options) => {
    calls.push({ file, args, options });
    const emitter = new EventEmitter();
    const child: SpawnedChild = {
      pid: 4321,
      once: (event: string, listener: (error: Error) => void) => emitter.once(event, listener),
      unref() {
        counters.unrefs += 1;
      },
    };
    setImmediate(() => {
      if (outcome === 'spawn') emitter.emit('spawn');
      else emitter.emit('error', outcome);
    });
    return child;
  };
  return { spawn, calls, counters };
}

describe('Edge app window (C.9, A.8)', () => {
  it('own profile, no first-run UI, no sign-in/sync (V2-01), app mode on the code URL', () => {
    const url = appUrlWithCode(serverOrigin(4711), sampleToken(1));
    expect(edgeProfileDir(HOME)).toBe(`${HOME}\\edge`);
    const args = edgeAppArgs({ home: HOME, url });
    expect(args).toEqual([
      `--user-data-dir=${HOME}\\edge`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--allow-browser-signin=false',
      `--disable-features=${EDGE_DISABLED_FEATURES.join(',')}`,
      `--app=http://127.0.0.1:4711/#code=${sampleToken(1)}`,
    ]);
    // The operative switch against the implicit Windows-account sign-in (measured, ADR-060).
    expect(EDGE_DISABLED_FEATURES[0]).toBe('msImplicitSignin');
    // One --disable-features only (a second one would replace the first), the URL stays last.
    expect(args.filter((arg) => arg.startsWith('--disable-features='))).toHaveLength(1);
    expect(args.at(-1)).toMatch(/^--app=/);
  });

  it('detects a profile that is already signed in (Local State), read-only', async () => {
    const home = await makeTempHome('r3-edgeprofile-');
    try {
      expect(await edgeProfileSignedIn(home)).toBe(false);
      await mkdir(edgeProfileDir(home), { recursive: true });
      const localState = (info: Record<string, unknown>) =>
        writeFile(
          path.join(edgeProfileDir(home), 'Local State'),
          JSON.stringify({ profile: { info_cache: info } }),
        );
      await localState({ Default: { user_name: '', name: 'Profil 1' } });
      expect(await edgeProfileSignedIn(home)).toBe(false);
      await localState({ Default: { user_name: 'someone@example.invalid', gaia_id: 'x' } });
      expect(await edgeProfileSignedIn(home)).toBe(true);
      await writeFile(path.join(edgeProfileDir(home), 'Local State'), '{ broken');
      expect(await edgeProfileSignedIn(home)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('starts the absolute msedge.exe detached with an argument array and unrefs it', async () => {
    const fake = fakeSpawn('spawn');
    const args = edgeAppArgs({ home: HOME, url: 'http://127.0.0.1:4711/#code=x' });
    expect(await openEdgeWindow(EDGE, args, fake.spawn)).toEqual({ pid: 4321 });
    expect(fake.calls).toEqual([{ file: EDGE, args, options: { detached: true, stdio: 'ignore' } }]);
    expect(fake.counters.unrefs).toBe(1);
  });

  it('rejects when Edge cannot be started', async () => {
    const fake = fakeSpawn(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    await expect(openEdgeWindow(EDGE, [], fake.spawn)).rejects.toThrow('spawn EACCES');
  });

  it('the default spawner refuses anything but an absolute .exe (R1-04)', async () => {
    await expect(openEdgeWindow('msedge', [])).rejects.toThrow(TypeError);
  });
});
