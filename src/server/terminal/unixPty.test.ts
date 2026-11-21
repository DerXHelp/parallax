/**
 * Linux pseudo terminal (WP-105). The pure parts run everywhere; the real pty only on Linux x64 with
 * `node:ffi` (the container of `scripts/linux`, CI) – it starts `/bin/bash` without rc files and
 * small `/bin/sh` scripts in a temp folder, never `claude`.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONSOLE_SETTINGS } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import { decodeTerminalFrame, type TerminalServerMessage } from '@shared/terminal';
import { sleep } from '../lib/async';
import { createLogger } from '../lib/logger';
import { isProcessAlive } from '../lib/process';
import { createPlatformPty } from './platformPty';
import type { PtyProcess, TerminalSink } from './ports';
import { createTerminalService, startFailureReason } from './service';
import {
  childExitCode,
  createUnixPtyFactory,
  loadUnixPty,
  UnixPtyError,
  unixPtyEnvironment,
  unixPtyUnavailableReason,
  winsize,
} from './unixPty';

describe('unixPtyEnvironment (WP-105)', () => {
  it('TERM and COLORTERM of xterm.js always, the outer terminal dropped, the rest kept', () => {
    const env = unixPtyEnvironment({
      HOME: '/home/demo',
      TERM: 'xterm-kitty',
      COLORTERM: '24bit',
      TERM_PROGRAM: 'vscode',
      TERM_PROGRAM_VERSION: '1.0',
      TMUX: '/tmp/tmux-1000/default,1,0',
      KITTY_WINDOW_ID: '3',
      VTE_VERSION: '7600',
      LANG: 'de_DE.UTF-8',
      UNSET: undefined,
    });
    expect(env).toEqual({
      HOME: '/home/demo',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'de_DE.UTF-8',
    });
  });

  it('LANG=C.UTF-8 only without any locale', () => {
    expect(unixPtyEnvironment({}).LANG).toBe('C.UTF-8');
    expect(unixPtyEnvironment({ LANG: '' }).LANG).toBe('C.UTF-8');
    expect(unixPtyEnvironment({ LC_ALL: 'C' })).not.toHaveProperty('LANG');
    expect(unixPtyEnvironment({ LC_CTYPE: 'en_US.UTF-8' })).not.toHaveProperty('LANG');
  });
});

describe('winsize and exit codes (WP-105)', () => {
  it('struct winsize: rows, cols (clamped), no pixels', () => {
    expect([...winsize(80, 24)]).toEqual([24, 0, 80, 0, 0, 0, 0, 0]);
    expect(winsize(0, 70_000).readUInt16LE(0)).toBe(0xffff);
    expect(winsize(0, 70_000).readUInt16LE(2)).toBe(1);
  });

  it('a signal ends with 128 + its number', () => {
    expect(childExitCode(0, null)).toBe(0);
    expect(childExitCode(7, null)).toBe(7);
    expect(childExitCode(null, 'SIGINT')).toBe(130);
    expect(childExitCode(null, 'SIGKILL')).toBe(137);
  });

  it('a failed start names the step and the errno, never a path', () => {
    expect(startFailureReason(new UnixPtyError('unlockpt', 5))).toBe('unlockpt (5)');
    expect(startFailureReason(new UnixPtyError('exec', 'ENOENT'))).toBe('exec (ENOENT)');
  });
});

describe('createPlatformPty (WP-105)', () => {
  it('nothing on other platforms; the other platform’s pty is unavailable with reason platform', () => {
    expect(createPlatformPty('freebsd')).toEqual({ pty: null, unavailableReason: 'platform' });
    if (process.platform !== 'linux') {
      expect(createPlatformPty('linux')).toEqual({ pty: null, unavailableReason: 'platform' });
      expect(unixPtyUnavailableReason()).toBe('platform');
      expect(loadUnixPty()).toBeNull();
    }
    if (process.platform !== 'win32') {
      expect(createPlatformPty('win32')).toEqual({ pty: null, unavailableReason: 'platform' });
    }
  });
});

// ---- the real pseudo terminal ----

const LIVE = process.platform === 'linux' && loadUnixPty() !== null;
const BASH = '/bin/bash';
/** bash without rc files and with a fixed prompt: deterministic output. */
const BASH_ARGS = ['--norc', '--noprofile', '-i'];

let folder = '';

beforeAll(async () => {
  if (LIVE) folder = await mkdtemp(path.join(os.tmpdir(), 'parallax-unixpty-'));
});

afterAll(async () => {
  if (folder !== '') await rm(folder, { recursive: true, force: true });
});

/** Polls `check` every 20 ms until it is true or `ms` passed. */
async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(20);
  }
}

/** A started bash with a reader that collects its output as text. */
function startBash(cols = 80, rows = 24) {
  const factory = createUnixPtyFactory();
  if (factory === null) throw new Error('no pty binding');
  const pty = factory.spawn({
    executablePath: BASH,
    args: BASH_ARGS,
    cwd: folder,
    env: { HOME: folder, PATH: '/usr/bin:/bin', PS1: 'ready$ ' },
    cols,
    rows,
  });
  let text = '';
  const pump = (): string => {
    for (let chunk = pty.read(65_536); chunk !== null; chunk = pty.read(65_536)) {
      text += Buffer.from(chunk).toString('utf8');
    }
    return text;
  };
  const waitFor = async (pattern: RegExp, ms?: number): Promise<RegExpMatchArray> => {
    await until(() => pattern.test(pump()), ms);
    const match = pattern.exec(text);
    if (match === null) throw new Error('no match');
    return match;
  };
  return { pty, pump, waitFor };
}

describe.runIf(LIVE)('Linux pty live (WP-105)', () => {
  it('runs bash in the folder on a terminal of its own; output, input, size and resize', async () => {
    const { pty, waitFor } = startBash(80, 24);
    try {
      expect(pty.pid).toBeGreaterThan(0);
      await waitFor(/ready\$ /);
      expect(pty.write('echo "out-$((40+2))"; pwd; tty; stty size; echo "term=$TERM/$COLORTERM"\r')).toBe(
        true,
      );
      await waitFor(/term=xterm-256color\/truecolor/);
      const all = await waitFor(/out-42[\s\S]*term=/);
      expect(all[0]).toContain(folder);
      expect(all[0]).toMatch(/\/dev\/pts\/\d+/);
      expect(all[0]).toContain('24 80');
      expect(pty.resize(100, 30)).toBe(true);
      pty.write('stty size\r');
      await waitFor(/30 100/);
    } finally {
      pty.close();
    }
  });

  it('Ctrl+C stops the foreground job (job control, no "no job control")', async () => {
    const { pty, waitFor, pump } = startBash();
    try {
      await waitFor(/ready\$ /);
      pty.write('sleep 30\r');
      await sleep(200);
      pty.write('\x03');
      pty.write('echo "after-$?"\r');
      await waitFor(/after-130/);
      expect(pump()).not.toMatch(/no job control/);
    } finally {
      pty.close();
    }
  });

  it('exit ends with the code; reading after the end gives nothing', async () => {
    const { pty, waitFor, pump } = startBash();
    try {
      await waitFor(/ready\$ /);
      pty.write('exit 7\r');
      await until(() => pty.exitCode() !== null);
      expect(pty.exitCode()).toBe(7);
      pump();
      expect(pty.read(1024)).toBeNull();
    } finally {
      pty.close();
    }
    // exitCode keeps answering after close (the service's liveness check).
    expect(pty.exitCode()).toBe(7);
  });

  it('large input goes out without blocking (queued while the terminal is full)', async () => {
    const { pty, waitFor } = startBash();
    try {
      await waitFor(/ready\$ /);
      pty.write('stty -echo; wc -l\r');
      await sleep(100);
      const line = `${'x'.repeat(49)}\r`;
      const started = Date.now();
      expect(pty.write(line.repeat(4000))).toBe(true);
      // The write returned at once (about 200 KiB; the line discipline takes ~18 KiB at a time).
      expect(Date.now() - started).toBeLessThan(500);
      pty.write('\x04');
      await waitFor(/\b4000\b/, 15_000);
    } finally {
      pty.close();
    }
  });

  it('close hangs up and ends the whole session, nohup jobs included', async () => {
    const { pty, waitFor } = startBash();
    let job = 0;
    try {
      await waitFor(/ready\$ /);
      pty.write('nohup sleep 300 >/dev/null 2>&1 &\r');
      pty.write('echo "job-$!"\r');
      job = Number((await waitFor(/job-(\d+)/))[1]);
      expect(isProcessAlive(job)).toBe(true);
    } finally {
      pty.close();
    }
    await until(() => pty.exitCode() !== null, 5000);
    await until(() => !isProcessAlive(job), 8000);
  });

  it('the terminal service starts the login shell and claude directly (no shell in between)', async () => {
    const script = path.join(folder, 'fake-claude');
    await writeFile(script, '#!/bin/sh\necho "resumed $1 $2 entry=$PARALLAX_ENTRY_ID"\nexit 3\n');
    await chmod(script, 0o755);
    const service = createTerminalService({
      pty: createUnixPtyFactory(),
      entry: () => ({ cwd: folder, archived: false }),
      settings: () => ({ ...DEFAULT_CONSOLE_SETTINGS, defaultShell: 'login' }),
      platform: 'linux',
      logger: createLogger({ level: 'silent' }),
    });
    const messages: TerminalServerMessage[] = [];
    let output = '';
    const sink: TerminalSink = {
      send: (message) => {
        messages.push(message);
      },
      sendFrame: (frame) => {
        const decoded = decodeTerminalFrame(frame);
        if (decoded !== null) output += Buffer.from(decoded.data).toString('utf8');
      },
      bufferedAmount: () => 0,
      close: () => undefined,
    };
    const connection = service.connect(SAMPLE_IDS.entry, sink);
    if ('code' in connection) throw new Error(connection.code);
    try {
      connection.handle({ type: 'open', requestId: 'r1', shell: 'login', cols: 80, rows: 24 });
      await until(() => messages.some((m) => m.type === 'opened'));
      const opened = messages.find((m) => m.type === 'opened');
      if (opened?.type !== 'opened') throw new Error('not opened');
      connection.handle({ type: 'attach', terminalId: opened.terminal.terminalId, cols: 80, rows: 24 });
      connection.handle({
        type: 'input',
        terminalId: opened.terminal.terminalId,
        data: 'echo "svc-$((6*7))"\r',
      });
      await until(() => output.includes('svc-42'));

      const claude = await service.openClaude(SAMPLE_IDS.entry, {
        executablePath: script,
        args: ['--resume', 'abc'],
        env: { PATH: '/usr/bin:/bin', PARALLAX: '1', PARALLAX_ENTRY_ID: 'en_demo' },
      });
      if (claude.kind !== 'opened') throw new Error(claude.error.code);
      expect(claude.pid).toBeGreaterThan(0);
      connection.handle({ type: 'attach', terminalId: claude.terminalId, cols: 80, rows: 24 });
      await until(() => output.includes('resumed --resume abc entry=en_demo'));
      await until(() => service.claudeState(claude.terminalId) === 'ended');
      const info = service.list(SAMPLE_IDS.entry).find((t) => t.terminalId === claude.terminalId);
      expect(info).toMatchObject({ command: 'claude', shell: 'login' });
      await until(
        () =>
          service.list(SAMPLE_IDS.entry).find((t) => t.terminalId === claude.terminalId)?.state === 'exited',
      );
      expect(service.list(SAMPLE_IDS.entry).find((t) => t.terminalId === claude.terminalId)?.exitCode).toBe(
        3,
      );
    } finally {
      connection.disconnect();
      await service.closeAll();
    }
  });

  it('a missing program fails before anything starts', () => {
    const factory = createUnixPtyFactory();
    if (factory === null) throw new Error('no pty binding');
    let caught: unknown = null;
    try {
      const pty: PtyProcess = factory.spawn({
        executablePath: path.join(folder, 'missing'),
        args: [],
        cwd: folder,
        env: {},
        cols: 80,
        rows: 24,
      });
      pty.close();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnixPtyError);
    expect(startFailureReason(caught)).toBe('exec (ENOENT)');
  });
});
