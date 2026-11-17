import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_NODE_FLAGS } from '../launcher/release';
import {
  APPLY_TIMEOUTS,
  UPDATE_READY_TIMEOUT_ENV,
  handshakeLine,
  orchestratorCommand,
  parseHandshakeLine,
  readyTimeoutMs,
} from './handoff';

const ROOT = 'C:\\Users\\<USER>\\AppData\\Local\\Programs\\Parallax';

describe('hand-over to the orchestrator (WP-87 §1.7)', () => {
  it('starts the launcher of the own version folder with the server flags, cwd = root', () => {
    const own = path.join(ROOT, 'versions', '1.0.0');
    const command = orchestratorCommand(
      {
        version: '1.0.1',
        restore: true,
        waitPid: 4242,
        installRoot: ROOT,
        serverArgs: ['--home=D:\\h', '--port=4711'],
      },
      own,
      'C:\\node\\node.exe',
    );
    expect(command).toEqual({
      file: 'C:\\node\\node.exe',
      args: [
        ...PACKAGE_NODE_FLAGS,
        path.join(own, 'dist', 'launcher.js'),
        `--install-root=${ROOT}`,
        '--apply-update=1.0.1',
        '--restore',
        '--wait-pid=4242',
        '--home=D:\\h',
        '--port=4711',
      ],
      cwd: ROOT,
    });
    const plain = orchestratorCommand(
      { version: '1.0.1', restore: false, waitPid: 1, installRoot: ROOT, serverArgs: [] },
      own,
    );
    expect(plain.args).not.toContain('--restore');
    expect(plain.file).toBe(process.execPath);
  });

  it('reads and writes handshake lines; unknown reasons count as spawn, other output is ignored', () => {
    expect(parseHandshakeLine(handshakeLine({ kind: 'ready' }))).toEqual({ kind: 'ready' });
    expect(parseHandshakeLine(`${handshakeLine({ kind: 'failed', reason: 'backup' })}\r`)).toEqual({
      kind: 'failed',
      reason: 'backup',
    });
    expect(parseHandshakeLine('PARALLAX-APPLY-FAILED something-new')).toEqual({
      kind: 'failed',
      reason: 'spawn',
    });
    expect(parseHandshakeLine('[launcher] waiting for the lock')).toBeNull();
  });

  it('takes the ready timeout from the environment only within 10…600 s', () => {
    expect(readyTimeoutMs({})).toBe(APPLY_TIMEOUTS.readyMs);
    expect(readyTimeoutMs({ [UPDATE_READY_TIMEOUT_ENV]: '180' })).toBe(180_000);
    expect(readyTimeoutMs({ [UPDATE_READY_TIMEOUT_ENV]: '5' })).toBe(APPLY_TIMEOUTS.readyMs);
    expect(readyTimeoutMs({ [UPDATE_READY_TIMEOUT_ENV]: '9000' })).toBe(APPLY_TIMEOUTS.readyMs);
    expect(readyTimeoutMs({ [UPDATE_READY_TIMEOUT_ENV]: '1e3' })).toBe(APPLY_TIMEOUTS.readyMs);
  });
});
