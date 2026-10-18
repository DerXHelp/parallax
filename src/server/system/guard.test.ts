/**
 * R6 guard (WP-30 §9): no test touches the real HKCU (`Software\Classes\parallax`), the real
 * autostart folder (`%APPDATA%`) or opens a console. Without an injected `run`/`env` the Windows
 * integration refuses in a test run before anything is spawned – checked here with a
 * `child_process.spawn` that fails the test if it is ever reached – and every test that builds an
 * integration injects its runner (static check below).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as ChildProcess from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { settingsSchema } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import { spawnHidden } from '../lib/process';
import { createConsoleLauncher } from './console';
import { createSystemIntegration } from './index';
import { TEST_RUN_REFUSAL, isTestProcess, systemEnv, systemRunner } from './run';

const spawned = vi.hoisted(() => [] as string[]);

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcess>();
  return {
    ...original,
    spawn: (file: string) => {
      spawned.push(file);
      throw new Error(`guard test: spawn of ${file} must not happen`);
    },
  };
});

const SPEC = {
  executablePath: 'C:\\Users\\u\\.local\\bin\\claude.exe',
  args: ['--resume', 'x'],
  env: {},
  explicitEnv: {},
  cwd: 'C:\\',
};

describe('R6: the Windows integration never runs for real in a test run', () => {
  it('this is a test run; the defaults are refused, the environment is empty', async () => {
    expect(isTestProcess()).toBe(true);
    expect(isTestProcess({ NODE_ENV: 'test' })).toBe(true);
    // R4-14: one rule with config.ts – under Vitest also a hand-made env counts as a test run.
    expect(isTestProcess({})).toBe(true);
    expect(systemEnv()).toEqual({});
    const env = { APPDATA: 'C:\\temp' };
    expect(systemEnv(env)).toBe(env);
    await expect(systemRunner()('C:\\Windows\\System32\\reg.exe', [], { timeoutMs: 1 })).rejects.toThrow(
      TEST_RUN_REFUSAL,
    );
    expect(spawned).toEqual([]);
  });

  it('console without an injected run: failed, nothing spawned', async () => {
    const launcher = createConsoleLauncher({ platform: 'win32' });
    const result = await launcher.open(SPEC);
    expect(result).toEqual({
      kind: 'failed',
      reason: `powershell could not be started: ${TEST_RUN_REFUSAL}`,
    });
    // The state query (CIM through PowerShell) is refused too: unknown, never ended.
    expect(await launcher.state({ pid: process.pid, startedAt: new Date() })).toBe('unknown');
    expect(spawned).toEqual([]);
  });

  it('autostart + protocol handler without run/env: warnings only, no HKCU, no shortcut', async () => {
    const integration = createSystemIntegration({
      available: true,
      repoRoot: 'D:\\dev\\parallax',
      home: 'D:\\px',
      platform: 'win32',
    });
    await integration.apply(
      settingsSchema.parse({
        autostart: { enabled: true, openWindow: true },
        notifications: { openOnClick: true },
      }),
    );
    expect(integration.warnings().map((w) => [w.id, w.error.params.reason])).toEqual([
      ['system:autostart', 'APPDATA is not set'],
      ['system:protocol', `reg.exe could not be started: ${TEST_RUN_REFUSAL}`],
    ]);
    expect(integration.toastLaunchUri(SAMPLE_IDS.entry)).toBeNull();
    expect(spawned).toEqual([]);
  });

  it('every server test that builds an integration injects its runner; none reads the real APPDATA', async () => {
    const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const self = fileURLToPath(import.meta.url);
    const files = (await readdir(serverDir, { recursive: true }))
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => path.join(serverDir, file))
      .filter((file) => file !== self);
    const factories =
      /\b(createSystemIntegration|createConsoleLauncher|createAutostartShortcut|removeAutostartShortcut)\(/;
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (/process\.env\.APPDATA|process\.env\['APPDATA'\]/.test(text))
        offenders.push(`${file}: real APPDATA`);
      if (factories.test(text) && !/\brun\b/.test(text)) offenders.push(`${file}: no injected run`);
    }
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(10);
  });

  it('(self-check) the spawn trap of this file is active', () => {
    expect(() => spawnHidden(process.execPath, ['--version'])).toThrow(/guard test/);
    expect(spawned).toEqual([process.execPath]);
    spawned.length = 0;
  });
});
