/**
 * Opt-in check of the real pseudo console (WP-99): runs only on Windows with
 * `PARALLAX_CONPTY_TEST=1` (PowerShell: `$env:PARALLAX_CONPTY_TEST='1'; pnpm exec vitest run
 * src/server/terminal/conpty.live.test.ts`). Starts cmd.exe headless in a temp folder – no window,
 * no `claude`. Everything else runs against the fake PTY.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE_IDS } from '@shared/samples';
import { DEFAULT_CONSOLE_SETTINGS } from '@shared/model';
import { decodeTerminalFrame, type TerminalServerMessage } from '@shared/terminal';
import { sleep } from '../lib/async';
import { createLogger } from '../lib/logger';
import { isProcessAlive, killProcessTree } from '../lib/process';
import { createConPtyFactory } from './conpty';
import type { PtyProcess, TerminalSink } from './ports';
import { createTerminalService } from './service';
import { resolveShellLaunch } from './shells';

const LIVE = process.platform === 'win32' && process.env.PARALLAX_CONPTY_TEST === '1';
const ENTRY = SAMPLE_IDS.entry;

let folder = '';

beforeAll(async () => {
  if (LIVE) folder = await mkdtemp(path.join(os.tmpdir(), 'parallax-conpty-'));
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

describe.runIf(LIVE)('ConPTY live (WP-99, opt-in)', () => {
  it('starts cmd, echoes, resizes, exits with the code and closes', async () => {
    const factory = createConPtyFactory();
    if (factory === null) throw new Error('no ConPTY binding');
    const launch = await resolveShellLaunch('cmd', folder, DEFAULT_CONSOLE_SETTINGS, 'embedded', {
      gitDir: () => Promise.resolve(null),
    });
    const pty: PtyProcess = factory.spawn({ ...launch, cwd: folder, cols: 80, rows: 24 });
    let text = '';
    const pump = (): boolean => {
      for (let chunk = pty.read(65_536); chunk !== null; chunk = pty.read(65_536)) {
        text += Buffer.from(chunk).toString('utf8');
      }
      return true;
    };
    try {
      expect(typeof pty.pid).toBe('number');
      await until(() => pump() && text.includes('>'));
      expect(pty.write('echo parallax-live\r')).toBe(true);
      await until(() => pump() && text.split('parallax-live').length >= 3);
      expect(pty.resize(100, 30)).toBe(true);
      expect(pty.write('exit 5\r')).toBe(true);
      await until(() => pump() && pty.exitCode() !== null);
      expect(pty.exitCode()).toBe(5);
    } finally {
      pty.close();
      pty.close();
    }
    expect(pty.read(10)).toBeNull();
    expect(pty.write('x')).toBe(false);
  }, 20_000);

  it('runs the service end to end: open, attach, input, exit, close', async () => {
    const factory = createConPtyFactory();
    const service = createTerminalService({
      pty: factory,
      entry: (id) => (id === ENTRY ? { cwd: folder, archived: false } : null),
      settings: () => DEFAULT_CONSOLE_SETTINGS,
      killTree: killProcessTree,
      logger: createLogger({ level: 'silent' }),
    });
    const messages: TerminalServerMessage[] = [];
    let output = '';
    const sink: TerminalSink = {
      send: (message) => messages.push(message),
      sendFrame: (frame) => {
        const decoded = decodeTerminalFrame(frame);
        if (decoded !== null) output += Buffer.from(decoded.data).toString('utf8');
      },
      bufferedAmount: () => 0,
      close: () => undefined,
    };
    const conn = service.connect(ENTRY, sink);
    if ('code' in conn) throw new Error(conn.code);
    try {
      const terminalOf = (requestId: string) => {
        const opened = messages.find((m) => m.type === 'opened' && m.requestId === requestId);
        return opened?.type === 'opened' ? opened.terminal : null;
      };
      conn.handle({ type: 'open', requestId: 'a', shell: 'cmd', cols: 80, rows: 24 });
      await until(() => terminalOf('a') !== null);
      const first = terminalOf('a');
      if (first === null) throw new Error('not opened');
      conn.handle({ type: 'attach', terminalId: first.terminalId, cols: 90, rows: 25 });
      conn.handle({ type: 'input', terminalId: first.terminalId, data: 'echo service-live\r' });
      await until(() => output.split('service-live').length >= 3);
      conn.handle({ type: 'input', terminalId: first.terminalId, data: 'exit 7\r' });
      await until(() => messages.some((m) => m.type === 'exit' && m.terminalId === first.terminalId));
      expect(messages.find((m) => m.type === 'exit')).toEqual({
        type: 'exit',
        terminalId: first.terminalId,
        exitCode: 7,
        reason: 'exited',
      });

      // A running shell ends with `close`, without taskkill.
      conn.handle({ type: 'open', requestId: 'b', shell: 'cmd', cols: 80, rows: 24 });
      await until(() => terminalOf('b') !== null);
      const second = terminalOf('b');
      if (second === null) throw new Error('not opened');
      await sleep(300);
      conn.handle({ type: 'close', terminalId: second.terminalId });
      expect(messages.at(-1)).toEqual({
        type: 'terminals',
        items: [{ ...first, cols: 90, rows: 25, state: 'exited', exitCode: 7 }],
      });
    } finally {
      conn.disconnect();
      await service.closeAll();
    }
  }, 30_000);

  it('ends the shell and its children with close (no taskkill needed)', async () => {
    const factory = createConPtyFactory();
    if (factory === null) throw new Error('no ConPTY binding');
    const launch = await resolveShellLaunch('cmd', folder, DEFAULT_CONSOLE_SETTINGS, 'embedded', {
      gitDir: () => Promise.resolve(null),
    });
    const pty = factory.spawn({ ...launch, cwd: folder, cols: 80, rows: 24 });
    const pid = pty.pid;
    if (pid === null) throw new Error('no pid');
    await sleep(300);
    pty.write('ping -t 127.0.0.1\r');
    await sleep(300);
    const started = Date.now();
    pty.close();
    expect(Date.now() - started).toBeLessThan(500);
    await until(() => !isProcessAlive(pid), 3000);
  }, 20_000);
});
