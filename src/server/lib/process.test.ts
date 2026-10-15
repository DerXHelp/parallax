import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSpawnableFile,
  childProcesses,
  errnoCode,
  isProcessAlive,
  killProcessTree,
  processInfo,
  processStartTime,
  runFile,
  spawnHidden,
  systemTool,
} from './process';

const NODE = process.execPath;
const windowsOnly = process.platform === 'win32' ? it : it.skip;

/**
 * Real child processes need real time: a node start takes ~1 s in a full `pnpm test` and several
 * seconds when parallel runs load the machine (docs/wp/FLAKES.md). Limits below are deadlines
 * (the tests wait for events), never fixed sleeps.
 */
const SPAWN_TEST_TIMEOUT_MS = 30_000;
/** taskkill + node start + liveness polling. */
const TREE_TEST_TIMEOUT_MS = 60_000;
/** PowerShell + CIM: 6 s idle, 15–25 s per call under load. */
const POWERSHELL_TEST_TIMEOUT_MS = 120_000;
const POWERSHELL_CALL_TIMEOUT_MS = 60_000;
/** Deadline for a child to report or to disappear. */
const PROCESS_DEADLINE_MS = 20_000;

/** Every PID a test started; killed in afterEach so no process survives a failing test. */
const started = new Set<number>();

afterEach(async () => {
  for (const pid of started) {
    if (isProcessAlive(pid)) await killProcessTree(pid).catch(() => undefined);
  }
  started.clear();
});

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

/** A node script that starts a long-running grandchild, prints its PID and then waits forever. */
const PARENT_WITH_GRANDCHILD = [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
  "process.stdout.write('grandchild:' + child.pid + '\\n');",
  'setInterval(() => {}, 1000);',
].join('\n');

function grandchildPid(stdout: string): number {
  const pid = Number(/grandchild:(\d+)/.exec(stdout)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`no grandchild pid in ${JSON.stringify(stdout)}`);
  started.add(pid);
  return pid;
}

describe('assertSpawnableFile (only absolute .exe paths, no shell – R1-04)', () => {
  it.each([
    'C:\\Users\\u\\.local\\bin\\claude.EXE',
    'C:\\Windows\\System32\\taskkill.exe',
    'D:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ])('accepts %s', (file) => {
    expect(() => {
      assertSpawnableFile(file, 'win32');
    }).not.toThrow();
  });

  it.each([
    // bare names: libuv would search the child's cwd first (planted git.exe in a cloned repo)
    'git',
    'git.exe',
    'explorer.exe',
    'taskkill',
    'claude.exe',
    // relative / drive-relative / unsafe locations
    '.\\git.exe',
    'tools\\git.exe',
    'C:git.exe',
    '\\\\server\\share\\git.exe',
    '\\\\?\\C:\\x\\git.exe',
    'C:\\x\\git.exe:stream',
    // not an .exe
    'C:\\x\\claude.cmd',
    'C:\\x\\run.bat',
    'C:\\x\\x.ps1',
    'C:\\x\\x.js',
    'C:\\x\\x.com',
    'C:\\x\\x.lnk',
    'C:\\x\\noext',
    '',
    'C:\\a\0b.exe',
  ])('rejects %j', (file) => {
    expect(() => {
      assertSpawnableFile(file, 'win32');
    }).toThrow(TypeError);
  });

  it('requires an absolute path on other platforms (tests only)', () => {
    expect(() => {
      assertSpawnableFile('/usr/bin/node', 'linux');
    }).not.toThrow();
    expect(() => {
      assertSpawnableFile('node', 'linux');
    }).toThrow(TypeError);
  });

  it('is enforced by runFile and spawnHidden for bare names', async () => {
    if (process.platform !== 'win32') return;
    await expect(runFile('git', ['--version'], { timeoutMs: 5_000 })).rejects.toBeInstanceOf(TypeError);
    expect(() => spawnHidden('explorer.exe', [])).toThrow(TypeError);
  });
});

describe('systemTool / errnoCode', () => {
  it('builds System32 paths from SystemRoot', () => {
    expect(systemTool('taskkill.exe', { SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\taskkill.exe',
    );
    expect(systemTool('reg.exe', {})).toBe('C:\\Windows\\System32\\reg.exe');
  });

  it('reads error codes', () => {
    expect(errnoCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(errnoCode(new Error('x'))).toBeUndefined();
    expect(errnoCode('ENOENT')).toBeUndefined();
  });
});

describe('runFile', { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it('returns stdout, stderr and the exit code without throwing on exit ≠ 0', async () => {
    const result = await runFile(
      NODE,
      ['-e', 'process.stdout.write("out ü"); process.stderr.write("err"); process.exit(3)'],
      { timeoutMs: 20_000 },
    );
    expect(result).toEqual({ exitCode: 3, signal: null, stdout: 'out ü', stderr: 'err', timedOut: false });
  });

  it('passes args verbatim (no shell: & | % " stay literal)', async () => {
    const tricky = ['a & echo pwned', '%PATH%', '"quoted"', 'x|y', ''];
    const result = await runFile(
      NODE,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky],
      {
        timeoutMs: 20_000,
      },
    );
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });

  it('uses exactly the given env and cwd', async () => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const result = await runFile(
      NODE,
      [
        '-e',
        'process.stdout.write(JSON.stringify([process.env.ONLY_THIS ?? null, process.env.CLAUDECODE ?? null, process.cwd().toLowerCase()]))',
      ],
      { timeoutMs: 20_000, env: { ONLY_THIS: 'yes', SystemRoot: systemRoot }, cwd: systemRoot },
    );
    expect(JSON.parse(result.stdout)).toEqual(['yes', null, systemRoot.toLowerCase()]);
  });

  it('caps the output per stream and still drains the pipe', async () => {
    const result = await runFile(
      NODE,
      ['-e', 'process.stdout.write("x".repeat(500000)); process.stderr.write("y".repeat(500000))'],
      { timeoutMs: 20_000, maxOutputBytes: 1000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('x'.repeat(1000));
    expect(result.stderr).toBe('y'.repeat(1000));
  });

  it('rejects when the file cannot be started', async () => {
    await expect(runFile('C:\\does\\not\\exist\\nope.exe', [], { timeoutMs: 5_000 })).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(runFile('C:\\x\\script.cmd', [], { timeoutMs: 5_000 })).rejects.toBeInstanceOf(TypeError);
  });

  windowsOnly(
    'kills the whole process tree on timeout (no surviving grandchild)',
    async () => {
      // The parent never exits, so the timeout always fires; it only has to leave the parent
      // enough time to start and print the grandchild's PID (1.5 s was too short under load).
      const result = await runFile(NODE, ['-e', PARENT_WITH_GRANDCHILD], { timeoutMs: 6_000 });
      expect(result.timedOut).toBe(true);
      const pid = grandchildPid(result.stdout);
      expect(await waitUntil(() => !isProcessAlive(pid), PROCESS_DEADLINE_MS)).toBe(true);
    },
    TREE_TEST_TIMEOUT_MS,
  );
});

describe('spawnHidden', { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  it('always drains stderr (F.16: a full pipe would block the child)', async () => {
    let received = 0;
    const child = spawnHidden(
      NODE,
      ['-e', 'process.stderr.write("e".repeat(3 * 1024 * 1024)); process.stdout.write("done")'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        onStderr: (text) => {
          received += text.length;
        },
      },
    );
    if (child.pid !== undefined) started.add(child.pid);
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const [code] = (await once(child, 'close')) as [number | null];
    expect(code).toBe(0);
    expect(stdout).toBe('done');
    expect(received).toBe(3 * 1024 * 1024);
  });

  it('drains stderr into the debug log without a callback', async () => {
    const child = spawnHidden(NODE, ['-e', 'process.stderr.write("e".repeat(2 * 1024 * 1024))']);
    if (child.pid !== undefined) started.add(child.pid);
    child.stdout?.resume();
    const [code] = (await once(child, 'close')) as [number | null];
    expect(code).toBe(0);
  });

  it('refuses shell-only files', () => {
    expect(() => spawnHidden('C:\\x\\claude.cmd', [])).toThrow(TypeError);
  });
});

describe('killProcessTree (taskkill /T /F)', () => {
  windowsOnly(
    'ends a process and its grandchild',
    async () => {
      const child = spawnHidden(NODE, ['-e', PARENT_WITH_GRANDCHILD], { stdio: ['ignore', 'pipe', 'pipe'] });
      const pid = child.pid;
      if (pid === undefined) throw new Error('no pid');
      started.add(pid);
      let stdout = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      expect(await waitUntil(() => stdout.includes('\n'), PROCESS_DEADLINE_MS)).toBe(true);
      const grandchild = grandchildPid(stdout);
      expect(isProcessAlive(grandchild)).toBe(true);

      await killProcessTree(pid);
      expect(
        await waitUntil(() => !isProcessAlive(pid) && !isProcessAlive(grandchild), PROCESS_DEADLINE_MS),
      ).toBe(true);
    },
    TREE_TEST_TIMEOUT_MS,
  );

  // Node start + taskkill start: ~3 s in a full `pnpm test`, over 5 s under parallel load.
  it(
    'treats an already finished process as success',
    async () => {
      const child = spawnHidden(NODE, ['-e', ''], { stdio: 'ignore' });
      const pid = child.pid;
      if (pid === undefined) throw new Error('no pid');
      await once(child, 'close');
      await expect(killProcessTree(pid)).resolves.toBeUndefined();
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it.each([0, -1, 1.5, Number.NaN, process.pid])('refuses pid %s', async (pid) => {
    await expect(killProcessTree(pid)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('processInfo (orphan cleanup, C.8)', () => {
  windowsOnly(
    'reports name, parent and start time of a running process',
    async () => {
      // The production default (20 s) is close to what one call takes under load; a timed-out
      // call would return null here.
      const info = await processInfo(process.pid, { timeoutMs: POWERSHELL_CALL_TIMEOUT_MS });
      expect(info).not.toBeNull();
      expect(info?.pid).toBe(process.pid);
      expect(info?.name.toLowerCase()).toBe('node.exe');
      expect(info?.parentPid).toBe(process.ppid);
      const startedAt = info?.startedAt.getTime() ?? 0;
      expect(startedAt).toBeLessThanOrEqual(Date.now());
      expect(startedAt).toBeGreaterThan(Date.now() - 24 * 3600 * 1000);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  windowsOnly(
    'returns null for a finished process',
    async () => {
      const child = spawnHidden(NODE, ['-e', ''], { stdio: 'ignore' });
      const pid = child.pid;
      if (pid === undefined) throw new Error('no pid');
      await once(child, 'close');
      expect(await processStartTime(pid)).toBeNull();
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  it('validates the pid', async () => {
    await expect(processInfo(0)).rejects.toBeInstanceOf(RangeError);
    await expect(childProcesses(-1)).rejects.toBeInstanceOf(RangeError);
  });

  windowsOnly(
    'childProcesses lists the direct children with name and start time (WP-13 §6 Nr. 7)',
    async () => {
      const child = spawnHidden(NODE, ['-e', PARENT_WITH_GRANDCHILD], { stdio: ['ignore', 'pipe', 'pipe'] });
      const pid = child.pid;
      if (pid === undefined) throw new Error('no pid');
      started.add(pid);
      let stdout = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      expect(await waitUntil(() => stdout.includes('\n'), PROCESS_DEADLINE_MS)).toBe(true);
      const grandchild = grandchildPid(stdout);
      // Two PowerShell calls: up to ~47 s together under load (the 60 s limit was nearly hit).
      const children = await childProcesses(pid, { timeoutMs: POWERSHELL_CALL_TIMEOUT_MS });
      const found = children.find((c) => c.pid === grandchild);
      expect(found).toMatchObject({ pid: grandchild, parentPid: pid });
      expect(found?.name.toLowerCase()).toBe('node.exe');
      expect(found?.startedAt.getTime()).toBeLessThanOrEqual(Date.now());
      // The grandchild starts no node.exe of its own (Windows may attach a conhost.exe).
      const grandchildren = await childProcesses(grandchild, { timeoutMs: POWERSHELL_CALL_TIMEOUT_MS });
      expect(grandchildren.filter((c) => c.name.toLowerCase() === 'node.exe')).toEqual([]);
      expect(grandchildren.every((c) => c.parentPid === grandchild)).toBe(true);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );
});
