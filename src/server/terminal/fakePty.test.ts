import { describe, expect, it } from 'vitest';
import {
  FAKE_FLOOD_MAX_LINES,
  createFakePtyFactory,
  fakePrompt,
  fakeScriptCommand,
  type FakePtyProcess,
} from './fakePty';

const CWD = 'D:\\Projects\\demo';
const CMD = 'C:\\Windows\\System32\\cmd.exe';

function start(executablePath = CMD): FakePtyProcess {
  const factory = createFakePtyFactory();
  const returned = factory.spawn({ executablePath, args: [], cwd: CWD, env: {}, cols: 80, rows: 24 });
  const pty = factory.spawned[0];
  if (pty === undefined) throw new Error('not recorded');
  expect(pty).toBe(returned);
  return pty;
}

function readAll(pty: FakePtyProcess, max = 1 << 20): string {
  const data = pty.read(max);
  return data === null ? '' : Buffer.from(data).toString('utf8');
}

describe('createFakePtyFactory (WP-99)', () => {
  it('prompts by the program name', () => {
    expect(fakePrompt(CMD, CWD)).toBe(`${CWD}>`);
    expect(fakePrompt('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.exe', CWD)).toBe(
      `PS ${CWD}> `,
    );
    expect(fakePrompt('C:\\Program Files\\Git\\bin\\bash.exe', CWD)).toBe('$ ');
    expect(fakePrompt('C:\\Tools\\other.exe', CWD)).toBe('> ');
    const pty = start();
    expect(pty.pid).toBeNull();
    expect(readAll(pty)).toBe(`${CWD}>`);
    expect(pty.read(10)).toBeNull();
  });

  it('echoes typed characters and runs echo on Enter', () => {
    const pty = start();
    readAll(pty);
    expect(pty.write('echo hi')).toBe(true);
    expect(readAll(pty)).toBe('echo hi');
    pty.write('\r');
    expect(readAll(pty)).toBe(`\r\nhi\r\n${CWD}>`);
    expect(pty.writes).toEqual(['echo hi', '\r']);
  });

  it('handles Backspace, escape sequences and Ctrl+C', () => {
    const pty = start();
    readAll(pty);
    pty.write('ab\x7f\x1b[A\x1bOPc');
    expect(readAll(pty)).toBe('ab\b \bc');
    pty.write('\x03');
    expect(readAll(pty)).toBe(`^C\r\n${CWD}>`);
    pty.write('\r');
    expect(readAll(pty)).toBe(`\r\n${CWD}>`);
  });

  it('answers unknown commands and clears the screen', () => {
    const pty = start();
    readAll(pty);
    pty.write('dir\r');
    expect(readAll(pty)).toContain("'dir' is not recognized");
    pty.write('cls\r');
    expect(readAll(pty)).toBe(`cls\r\n\x1b[2J\x1b[H${CWD}>`);
  });

  it('floods lazily within the read limit', () => {
    const pty = start();
    readAll(pty);
    pty.write('flood 5000\r');
    const first = pty.read(100);
    expect(first?.length).toBe(100);
    let text = Buffer.from(first ?? new Uint8Array()).toString('utf8');
    for (;;) {
      const chunk = pty.read(64 * 1024);
      if (chunk === null) break;
      expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
      text += Buffer.from(chunk).toString('utf8');
    }
    expect(text).toContain('line 1\r\n');
    expect(text).toContain('line 5000\r\n');
    expect(text).not.toContain('line 5001');
    expect(text.endsWith(`${CWD}>`)).toBe(true);
    expect(FAKE_FLOOD_MAX_LINES).toBe(100_000);
  });

  it('exits with the given code and stops taking input', () => {
    const pty = start('C:\\Program Files\\Git\\bin\\bash.exe');
    readAll(pty);
    pty.write('exit 3\r');
    expect(readAll(pty)).toBe('exit 3\r\n');
    expect(pty.exitCode()).toBe(3);
    expect(pty.write('x')).toBe(false);
    const other = start();
    other.write('exit\r');
    expect(other.exitCode()).toBe(0);
  });

  it('records resizes, emits output and closes idempotently', () => {
    const pty = start();
    readAll(pty);
    expect(pty.resize(100, 30)).toBe(true);
    expect(pty.resizes).toEqual([[100, 30]]);
    pty.emit('out');
    expect(pty.pendingBytes()).toBe(3);
    pty.exit(7);
    pty.exit(9);
    expect(pty.exitCode()).toBe(7);
    pty.close();
    pty.close();
    expect(pty.closed).toBe(true);
    expect(pty.read(10)).toBeNull();
    expect(pty.resize(10, 10)).toBe(false);
  });
});

describe('fake script runs (WP-111)', () => {
  it('reads the command of a verbatim cmd line or of -c / -Command', () => {
    expect(
      fakeScriptCommand({ args: [], windowsCommandLine: '"C:\\cmd.exe" /d /s /c "echo a && exit 2"' }),
    ).toBe('echo a && exit 2');
    expect(fakeScriptCommand({ args: ['-l', '-c', 'echo b'] })).toBe('echo b');
    expect(fakeScriptCommand({ args: ['-NoLogo', '-Command', 'echo c'] })).toBe('echo c');
    expect(fakeScriptCommand({ args: ['--login', '-i'] })).toBeNull();
  });

  it('runs the parts without a prompt and ends with the code', () => {
    const factory = createFakePtyFactory();
    const base = { executablePath: CMD, cwd: CWD, env: {}, cols: 80, rows: 24 };
    const ok = factory.spawn({ ...base, args: ['-c', 'echo one && echo two'] });
    expect(Buffer.from(ok.read(1000) ?? new Uint8Array()).toString('utf8')).toBe('one\r\ntwo\r\n');
    expect(ok.exitCode()).toBe(0);
    expect(factory.spawn({ ...base, args: ['-c', 'echo x && exit 4 && echo never'] }).exitCode()).toBe(4);
    expect(factory.spawn({ ...base, args: ['-c', 'pnpm install'] }).exitCode()).toBe(1);
  });
});
