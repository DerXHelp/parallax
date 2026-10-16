import { describe, expect, it } from 'vitest';
import type { ConsoleLaunchSpec } from '../claude/ports';
import { FAKE_CONSOLE_FIRST_PID, FAKE_CONSOLE_RUN_MS, createFakeConsoleLauncher } from './fakeConsole';

const SPEC: ConsoleLaunchSpec = {
  executablePath: 'C:\\fake\\claude.exe',
  args: ['--resume', 'x'],
  env: {},
  explicitEnv: {},
  cwd: 'D:\\work',
};

describe('createFakeConsoleLauncher (--backend=fake, E2E)', () => {
  it('opens nothing: synthetic PIDs ≥ 50 000, the spec goes to onRun', async () => {
    const seen: ConsoleLaunchSpec[] = [];
    let now = new Date('2026-10-16T08:00:00.000Z');
    const fake = createFakeConsoleLauncher({ onRun: (spec) => seen.push(spec), now: () => now });
    const first = await fake.open(SPEC);
    const second = await fake.open(SPEC);
    expect(first).toEqual({ kind: 'opened', process: { pid: FAKE_CONSOLE_FIRST_PID, startedAt: now } });
    expect(second).toMatchObject({ process: { pid: FAKE_CONSOLE_FIRST_PID + 1 } });
    expect(seen).toEqual([SPEC, SPEC]);
    if (first.kind !== 'opened') throw new Error('expected opened');
    expect(await fake.state(first.process)).toBe('running');
    now = new Date(now.getTime() + FAKE_CONSOLE_RUN_MS - 1);
    expect(await fake.state(first.process)).toBe('running');
    now = new Date(now.getTime() + 1);
    expect(await fake.state(first.process)).toBe('ended');
  });

  it('runMs is configurable; without a start time (after a restart) the console has ended', async () => {
    let now = new Date('2026-10-16T08:00:00.000Z');
    const fake = createFakeConsoleLauncher({ runMs: 10_000, now: () => now });
    const opened = await fake.open(SPEC);
    if (opened.kind !== 'opened') throw new Error('expected opened');
    now = new Date(now.getTime() + 9_000);
    expect(await fake.state(opened.process)).toBe('running');
    expect(await fake.state({ pid: 1, startedAt: null })).toBe('ended');
  });

  it('a throwing onRun does not fail the open', async () => {
    const fake = createFakeConsoleLauncher({
      onRun: () => {
        throw new Error('hook');
      },
    });
    expect((await fake.open(SPEC)).kind).toBe('opened');
  });
});
