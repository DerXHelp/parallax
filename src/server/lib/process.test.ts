import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import {
  assertSpawnableFile,
  childProcesses,
  descendantsOf,
  errnoCode,
  isProcessAlive,
  killProcessTree,
  listProcesses,
  processInfo,
  processStartTime,
  posixKillTargets,
  queryProcesses,
  runFile,
  spawnHidden,
  systemTool,
  type PosixKillDeps,
} from './process';
import { processImageName, type ProcStat } from './procfs';
import { loadNativeProcessApi, type NativeProcessApi, type NativeProcessEntry } from './processNative';

const NODE = process.execPath;
const windowsOnly = process.platform === 'win32' ? it : it.skip;
/** Hosts with a process table and process trees (Windows: Toolhelp + taskkill, Linux: /proc + groups). */
const nativeHost = process.platform === 'win32' || process.platform === 'linux' ? it : it.skip;
/**
 * Image name of a running node process: Windows `node.exe`; Linux its `comm`, which node itself renames
 * (`node-MainThread`) – read from /proc, never derived from the executable.
 */
function nodeImageName(pid: number = process.pid): string {
  if (process.platform === 'win32') return 'node.exe';
  return readFileSync(`/proc/${pid === process.pid ? 'self' : String(pid)}/comm`, 'utf8').trim();
}
/** A path that does not exist, absolute after the rules of this host. */
const MISSING_EXE = process.platform === 'win32' ? 'C:\\does\\not\\exist\\nope.exe' : '/does/not/exist/nope';

/**
 * Real child processes need real time: a node start takes ~1 s in a full `pnpm test` and several
 * seconds when parallel runs load the machine (docs/wp/FLAKES.md). Limits below are deadlines
 * (the tests wait for events), never fixed sleeps.
 */
const SPAWN_TEST_TIMEOUT_MS = 30_000;
/** taskkill + node start + liveness polling. */
const TREE_TEST_TIMEOUT_MS = 60_000;
/** Node children + the native snapshot (ms) – the deadline is for the node starts under load. */
const QUERY_TEST_TIMEOUT_MS = 60_000;
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

  it('POSIX (WP-103): an absolute, safe path – any name, no .exe (checked by the POSIX rules)', () => {
    expect(() => {
      assertSpawnableFile('/usr/bin/node', 'linux');
    }).not.toThrow();
    expect(() => {
      assertSpawnableFile('/home/u/.local/bin/claude', 'linux');
    }).not.toThrow();
    for (const file of [
      'node',
      './node',
      'bin/node',
      'C:\\x\\node.exe',
      '',
      '/usr/bin/no\0de',
      '/proc/self/exe',
    ]) {
      expect(() => {
        assertSpawnableFile(file, 'linux');
      }, file).toThrow(TypeError);
    }
  });

  it.runIf(process.platform === 'linux')('POSIX: an existing file must be executable (X_OK)', async () => {
    const dir = await makeTempHome('spawnable-');
    try {
      const plain = path.join(dir, 'plain');
      const tool = path.join(dir, 'tool');
      writeFileSync(plain, '#!/bin/sh\n', { mode: 0o644 });
      writeFileSync(tool, '#!/bin/sh\n', { mode: 0o755 });
      expect(() => {
        assertSpawnableFile(plain);
      }).toThrow(/not an executable file/);
      expect(() => {
        assertSpawnableFile(dir);
      }).toThrow(/not an executable file/);
      expect(() => {
        assertSpawnableFile(tool);
      }).not.toThrow();
      // Missing: spawn reports ENOENT itself.
      expect(() => {
        assertSpawnableFile(path.join(dir, 'missing'));
      }).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is enforced by runFile and spawnHidden for bare names', async () => {
    await expect(runFile('git', ['--version'], { timeoutMs: 5_000 })).rejects.toBeInstanceOf(TypeError);
    expect(() => spawnHidden('explorer.exe', [])).toThrow(TypeError);
  });
});

describe('systemTool / errnoCode', () => {
  it('builds System32 paths from SystemRoot', () => {
    expect(systemTool('taskkill.exe', { SystemRoot: 'C:\\Windows' }, 'win32')).toBe(
      'C:\\Windows\\System32\\taskkill.exe',
    );
    expect(systemTool('reg.exe', {}, 'win32')).toBe('C:\\Windows\\System32\\reg.exe');
    // A Windows tool name stays a Windows path everywhere (spawning it off Windows is refused).
    expect(systemTool('tar.exe', {}, 'linux')).toBe('C:\\Windows\\System32\\tar.exe');
    expect(systemTool('WindowsPowerShell\\v1.0\\powershell.exe', {}, 'linux')).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(() => {
      assertSpawnableFile(systemTool('reg.exe', {}, 'linux'), 'linux');
    }).toThrow(TypeError);
  });

  it.runIf(process.platform === 'linux')('POSIX: /usr/bin, then /bin (WP-103)', () => {
    expect(systemTool('sh', {}, 'linux')).toMatch(/^\/(usr\/)?bin\/sh$/);
    expect(() => systemTool('../sh', {}, 'linux')).toThrow(TypeError);
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
    const windows = process.platform === 'win32';
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const cwd = windows ? systemRoot : '/';
    const result = await runFile(
      NODE,
      [
        '-e',
        'process.stdout.write(JSON.stringify([process.env.ONLY_THIS ?? null, process.env.CLAUDECODE ?? null, process.cwd().toLowerCase()]))',
      ],
      {
        timeoutMs: 20_000,
        env: windows ? { ONLY_THIS: 'yes', SystemRoot: systemRoot } : { ONLY_THIS: 'yes' },
        cwd,
      },
    );
    expect(JSON.parse(result.stdout)).toEqual(['yes', null, cwd.toLowerCase()]);
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
    await expect(runFile(MISSING_EXE, [], { timeoutMs: 5_000 })).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(runFile('C:\\x\\script.cmd', [], { timeoutMs: 5_000 })).rejects.toBeInstanceOf(TypeError);
  });

  nativeHost(
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

  it('an already aborted signal starts nothing (V3-15)', async () => {
    const abort = new AbortController();
    abort.abort();
    expect(await runFile(MISSING_EXE, [], { timeoutMs: 5_000, signal: abort.signal })).toEqual({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: true,
    });
  });

  nativeHost(
    'an abort ends the whole process tree like the timeout (V3-15)',
    async () => {
      const dir = await makeTempHome('runfile-abort-');
      const marker = path.join(dir, 'grandchild.pid');
      const script = [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
        "require('node:fs').writeFileSync(process.argv[1], String(child.pid));",
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const abort = new AbortController();
      const running = runFile(NODE, ['-e', script, marker], { timeoutMs: 120_000, signal: abort.signal });
      expect(await waitUntil(() => existsSync(marker), PROCESS_DEADLINE_MS)).toBe(true);
      const pid = Number(readFileSync(marker, 'utf8'));
      started.add(pid);
      abort.abort();
      expect((await running).timedOut).toBe(true);
      expect(await waitUntil(() => !isProcessAlive(pid), PROCESS_DEADLINE_MS)).toBe(true);
      await rm(dir, { recursive: true, force: true });
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

describe('killProcessTree (Windows taskkill /T /F, Linux process groups)', () => {
  nativeHost(
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

/** Starts `script` with node (detached on POSIX: its own group) and resolves its PID and first line. */
async function startScript(script: string, args: string[] = []): Promise<{ pid: number; line: string }> {
  const child = spawnHidden(NODE, ['-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  if (pid === undefined) throw new Error('no pid');
  started.add(pid);
  let stdout = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  if (!(await waitUntil(() => stdout.includes('\n'), PROCESS_DEADLINE_MS))) throw new Error('no output');
  return { pid, line: stdout.split('\n')[0] ?? '' };
}

describe.runIf(process.platform === 'linux')(
  'killProcessTree on Linux: groups, sessions, /proc (WP-103)',
  () => {
    it(
      'also ends a grandchild that left the group and session with setsid (detached)',
      async () => {
        const script = [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });",
          "process.stdout.write('grandchild:' + child.pid + '\\n');",
          'setInterval(() => {}, 1000);',
        ].join('\n');
        const parent = await startScript(script);
        const grandchild = grandchildPid(parent.line);
        const stat = readFileSync(`/proc/${String(grandchild)}/stat`, 'utf8');
        // Own group and session (fields 5 and 6 after the comm).
        const [, , pgid, sid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        expect([Number(pgid), Number(sid)]).toEqual([grandchild, grandchild]);
        await killProcessTree(parent.pid);
        expect(
          await waitUntil(
            () => !isProcessAlive(parent.pid) && !isProcessAlive(grandchild),
            PROCESS_DEADLINE_MS,
          ),
        ).toBe(true);
      },
      TREE_TEST_TIMEOUT_MS,
    );

    it(
      'ends an orphan of the group whose parent already ended',
      async () => {
        const script = [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stdout.write('grandchild:' + child.pid + '\\n');",
          'setTimeout(() => process.exit(0), 200);',
        ].join('\n');
        const parent = await startScript(script);
        const grandchild = grandchildPid(parent.line);
        expect(await waitUntil(() => !isProcessAlive(parent.pid), PROCESS_DEADLINE_MS)).toBe(true);
        expect(isProcessAlive(grandchild)).toBe(true);
        await killProcessTree(parent.pid);
        expect(await waitUntil(() => !isProcessAlive(grandchild), PROCESS_DEADLINE_MS)).toBe(true);
      },
      TREE_TEST_TIMEOUT_MS,
    );

    it(
      'SIGTERM first: a process that handles it ends on its own before any SIGKILL',
      async () => {
        const dir = await makeTempHome('kill-term-');
        const marker = path.join(dir, 'term');
        const script = [
          "process.on('SIGTERM', () => { require('node:fs').writeFileSync(process.argv[1], 'term'); process.exit(0); });",
          "process.stdout.write('ready\\n');",
          'setInterval(() => {}, 1000);',
        ].join('\n');
        try {
          const child = await startScript(script, [marker]);
          expect(child.line).toBe('ready');
          await killProcessTree(child.pid, { graceMs: 15_000 });
          expect(readFileSync(marker, 'utf8')).toBe('term');
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      TREE_TEST_TIMEOUT_MS,
    );

    it(
      'SIGKILL after the grace period for a process that ignores SIGTERM',
      async () => {
        const child = await startScript(
          "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
        );
        await killProcessTree(child.pid, { graceMs: 300 });
        expect(await waitUntil(() => !isProcessAlive(child.pid), PROCESS_DEADLINE_MS)).toBe(true);
      },
      TREE_TEST_TIMEOUT_MS,
    );
  },
);

describe('killProcessTree POSIX logic with a fake table (WP-103)', () => {
  /** One `/proc` row; start ticks default to the PID (younger PIDs started later). */
  const row = (pid: number, ppid: number, pgid: number, sid: number, startTicks = pid): ProcStat => ({
    pid,
    comm: `p${String(pid)}`,
    state: 'S',
    ppid,
    pgid,
    sid,
    startTicks,
  });
  const sorted = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);
  const pids = (rows: readonly ProcStat[]): number[] => sorted(rows.map((p) => p.pid));
  const SERVER = 50;
  /** The server (group 40, session 30 – e.g. started from a terminal) and a foreign process. */
  const base = [
    row(30, 1, 30, 30, 1),
    row(40, 30, 40, 30, 2),
    row(SERVER, 40, 40, 30, 3),
    row(900, 1, 900, 900),
  ];

  interface Behaviour {
    ignoresTerm?: Set<number>;
    unkillable?: Set<number>;
    /** Becomes a zombie instead of disappearing. */
    zombie?: Set<number>;
  }

  function simulate(rows: ProcStat[], behaviour: Behaviour = {}, withTable = true) {
    const live = new Map(rows.map((r) => [r.pid, { ...r }]));
    const signals: string[] = [];
    let clock = 0;
    const end = (p: ProcStat, signal: NodeJS.Signals): void => {
      if (behaviour.unkillable?.has(p.pid) === true) return;
      if (signal === 'SIGTERM' && behaviour.ignoresTerm?.has(p.pid) === true) return;
      if (behaviour.zombie?.has(p.pid) === true) live.set(p.pid, { ...p, state: 'Z' });
      else live.delete(p.pid);
    };
    const esrch = (): Error => Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    const deps: PosixKillDeps = {
      table: () => (withTable ? [...live.values()] : null),
      stat: (pid) => live.get(pid) ?? null,
      kill: (target, signal) => {
        const hit =
          target < 0
            ? [...live.values()].filter((p) => p.pgid === -target)
            : [live.get(target)].filter((p) => p !== undefined);
        // Like the kernel: probing a zombie succeeds.
        if (signal === 0) {
          if (hit.length === 0) throw esrch();
          return;
        }
        signals.push(`${String(target)}:${signal}`);
        if (hit.length === 0) throw esrch();
        for (const p of hit) end(p, signal);
      },
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      ownPid: SERVER,
    };
    return { deps, signals, live, elapsed: () => clock };
  }

  it('the tree: descendants, setsid grandchildren, orphans of its groups and sessions – nothing else', () => {
    const table = [
      ...base,
      row(100, SERVER, 100, 100), // claude, started detached: group and session leader
      row(101, 100, 100, 100), // its child
      row(102, 101, 102, 102), // a grandchild with setsid
      row(103, 102, 102, 102), // below it
      row(104, 1, 100, 100), // orphan in the group (parent ended)
      row(105, 1, 105, 100), // orphan with its own group, still in the session
      row(106, 1, 106, 106), // orphan with setsid whose parent ended: not findable – not ours
      row(99, 100, 99, 99), // "child" older than its parent: a reused PID
    ];
    const targets = posixKillTargets(table, 100, SERVER);
    expect(pids(targets.processes)).toEqual([100, 101, 102, 103, 104, 105]);
    expect(sorted(targets.groups)).toEqual([100, 102, 105]);
  });

  it('never the server, its group or its session – a child in the server group is signalled alone', () => {
    const table = [...base, row(100, SERVER, 40, 30), row(101, 100, 40, 30), row(102, 40, 40, 30)];
    const targets = posixKillTargets(table, 100, SERVER);
    expect(pids(targets.processes)).toEqual([100, 101]);
    expect(targets.groups).toEqual([]);
    expect(posixKillTargets(table, SERVER, SERVER).processes).toEqual([]);
    // The server's parent: its other children, but never the server or the shared group.
    const parent = posixKillTargets(table, 40, SERVER);
    expect(pids(parent.processes)).toEqual([40, 102]);
    expect(parent.groups).toEqual([]);
  });

  it('the group and session of an ended root are still its own (no PID names a living group twice)', () => {
    const table = [...base, row(101, 1, 100, 100), row(102, 101, 102, 100)];
    const targets = posixKillTargets(table, 100, SERVER);
    expect(pids(targets.processes)).toEqual([101, 102]);
    expect(sorted(targets.groups)).toEqual([100, 102]);
  });

  it('SIGTERM to every group (and to members outside them); no SIGKILL when they end', async () => {
    const sim = simulate([
      ...base,
      row(100, SERVER, 100, 100),
      row(101, 100, 100, 100),
      row(102, 101, 102, 102),
    ]);
    await killProcessTree(100, { platform: 'linux', posix: sim.deps, graceMs: 2_000 });
    expect(sim.signals.sort()).toEqual(['-100:SIGTERM', '-102:SIGTERM']);
    expect(sorted([...sim.live.keys()])).toEqual([30, 40, SERVER, 900]);
  });

  it('a child in the server group gets its signal by PID – never the group', async () => {
    const sim = simulate([...base, row(100, SERVER, 40, 30)]);
    await killProcessTree(100, { platform: 'linux', posix: sim.deps });
    expect(sim.signals).toEqual(['100:SIGTERM']);
  });

  it('SIGKILL after the grace period for what ignores SIGTERM', async () => {
    const sim = simulate([...base, row(100, SERVER, 100, 100), row(101, 100, 100, 100)], {
      ignoresTerm: new Set([101]),
    });
    await killProcessTree(100, { platform: 'linux', posix: sim.deps, graceMs: 2_000 });
    expect(sim.signals).toEqual(['-100:SIGTERM', '-100:SIGKILL']);
    expect(sim.elapsed()).toBeGreaterThanOrEqual(2_000);
    expect(sim.live.has(101)).toBe(false);
  });

  it('a zombie counts as gone; an already ended process is no error', async () => {
    const zombie = simulate([...base, row(100, SERVER, 100, 100)], { zombie: new Set([100]) });
    await killProcessTree(100, { platform: 'linux', posix: zombie.deps });
    expect(zombie.signals).toEqual(['-100:SIGTERM']);
    const gone = simulate(base);
    await killProcessTree(100, { platform: 'linux', posix: gone.deps });
    expect(gone.signals).toEqual([]);
  });

  it('rejects when the process survives SIGKILL', async () => {
    const sim = simulate([...base, row(100, SERVER, 100, 100)], { unkillable: new Set([100]) });
    await expect(killProcessTree(100, { platform: 'linux', posix: sim.deps, graceMs: 100 })).rejects.toThrow(
      /still runs after SIGKILL/,
    );
  });

  it('without a process table: the process and the group it leads', async () => {
    const sim = simulate([...base, row(100, SERVER, 100, 100), row(101, 100, 100, 100)], {}, false);
    await killProcessTree(100, { platform: 'linux', posix: sim.deps });
    expect(sim.signals).toEqual(['-100:SIGTERM', '100:SIGTERM']);
    expect(sim.live.has(101)).toBe(false);
  });
});

describe('processInfo / queryProcesses (orphan cleanup, C.8, R2-02)', () => {
  nativeHost(
    'reports name, parent and start time of a running process',
    async () => {
      const info = await processInfo(process.pid);
      expect(info.kind).toBe('found');
      if (info.kind !== 'found') return;
      expect(info.info.pid).toBe(process.pid);
      expect(info.info.name.toLowerCase()).toBe(nodeImageName().toLowerCase());
      expect(info.info.parentPid).toBe(process.ppid);
      const startedAt = info.info.startedAt.getTime();
      expect(startedAt).toBeLessThanOrEqual(Date.now());
      expect(startedAt).toBeGreaterThan(Date.now() - 24 * 3600 * 1000);
    },
    QUERY_TEST_TIMEOUT_MS,
  );

  nativeHost(
    'answers missing for a finished process',
    async () => {
      const child = spawnHidden(NODE, ['-e', ''], { stdio: 'ignore' });
      const pid = child.pid;
      if (pid === undefined) throw new Error('no pid');
      await once(child, 'close');
      expect(await processInfo(pid)).toEqual({ kind: 'missing' });
      expect(await processStartTime(pid)).toBeNull();
    },
    QUERY_TEST_TIMEOUT_MS,
  );

  nativeHost(
    'one query for several pids and the children of a parent',
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
      const result = await queryProcesses({ pids: [process.pid, pid], parentPids: [pid] });
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      const pids = result.processes.map((p) => p.pid);
      expect(pids).toEqual(expect.arrayContaining([process.pid, pid, grandchild]));
      expect(result.processes.find((p) => p.pid === grandchild)?.parentPid).toBe(pid);
    },
    QUERY_TEST_TIMEOUT_MS,
  );

  it('validates the pids', async () => {
    await expect(processInfo(0)).rejects.toBeInstanceOf(RangeError);
    await expect(childProcesses(-1)).rejects.toBeInstanceOf(RangeError);
    await expect(queryProcesses({ pids: [1.5] })).rejects.toBeInstanceOf(RangeError);
  });

  nativeHost(
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
      const children = await childProcesses(pid);
      expect(children.kind).toBe('ok');
      if (children.kind !== 'ok') return;
      const found = children.processes.find((c) => c.pid === grandchild);
      expect(found).toMatchObject({ pid: grandchild, parentPid: pid });
      // Linux: right after the start the comm may still be the executable name (node renames its main thread).
      const names = [nodeImageName(grandchild).toLowerCase()];
      if (process.platform !== 'win32') names.push(processImageName(NODE).toLowerCase());
      expect(names).toContain(found?.name.toLowerCase());
      expect(found?.startedAt.getTime()).toBeLessThanOrEqual(Date.now());
      // The grandchild starts no node.exe of its own (Windows may attach a conhost.exe).
      const grandchildren = await childProcesses(grandchild);
      expect(grandchildren.kind).toBe('ok');
      if (grandchildren.kind !== 'ok') return;
      expect(grandchildren.processes.filter((c) => names.includes(c.name.toLowerCase()))).toEqual([]);
      expect(grandchildren.processes.every((c) => c.parentPid === grandchild)).toBe(true);
    },
    QUERY_TEST_TIMEOUT_MS,
  );
});

describe('native process list (ADR-229, ADR-231: never PowerShell)', () => {
  const at = (s: number) => new Date(Date.parse('2026-11-18T12:00:00.000Z') + s * 1000);
  const fake = (rows: NativeProcessEntry[] | null, times: Record<number, Date>): NativeProcessApi => ({
    entries: () => rows,
    startedAt: (pid) => times[pid] ?? null,
  });
  const rows: NativeProcessEntry[] = [
    { pid: 10, parentPid: 1, name: 'claude.exe' },
    { pid: 11, parentPid: 10, name: 'node.exe' },
    { pid: 12, parentPid: 10, name: 'service.exe' },
    { pid: 13, parentPid: 2, name: 'other.exe' },
  ];
  const native = fake(rows, { 10: at(0), 11: at(1), 13: at(2) });

  it('filters by pid and parent and leaves out a process without readable start time', async () => {
    const options = { native, platform: 'win32' as const };
    expect(await queryProcesses({ pids: [10], parentPids: [10] }, options)).toEqual({
      kind: 'ok',
      processes: [
        { pid: 10, name: 'claude.exe', parentPid: 1, startedAt: at(0) },
        { pid: 11, name: 'node.exe', parentPid: 10, startedAt: at(1) },
      ],
    });
    expect(await processInfo(12, options)).toEqual({ kind: 'missing' });
    expect(await processInfo(13, options)).toMatchObject({ kind: 'found', info: { name: 'other.exe' } });
    const all = await listProcesses(options);
    expect(all.kind === 'ok' ? all.processes.map((info) => info.pid) : null).toEqual([10, 11, 13]);
    expect(await childProcesses(10, options)).toMatchObject({ kind: 'ok', processes: [{ pid: 11 }] });
  });

  it('a failed snapshot is unknown – never an empty list', async () => {
    const broken = fake(null, {});
    expect(await listProcesses({ native: broken, platform: 'win32' })).toMatchObject({
      kind: 'unknown',
      reason: 'failed',
    });
    expect(await processInfo(10, { native: broken, platform: 'win32' })).toMatchObject({ kind: 'unknown' });
  });

  it('without node:ffi (native null) and off Windows/Linux every query is unknown – never "gone"', async () => {
    const none = { native: null, platform: 'win32' as const };
    expect(await processInfo(10, none)).toMatchObject({ kind: 'unknown', reason: 'unsupported' });
    expect(await listProcesses(none)).toMatchObject({ kind: 'unknown', reason: 'unsupported' });
    expect(await childProcesses(10, none)).toMatchObject({ kind: 'unknown', reason: 'unsupported' });
    expect(await queryProcesses({ pids: [10] }, { native, platform: 'darwin' })).toMatchObject({
      kind: 'unknown',
      reason: 'unsupported',
    });
    expect(await processStartTime(10, none)).toBeNull();
  });

  it('an empty filter answers ok [] without a snapshot; invalid pids reject', async () => {
    const untouchable: NativeProcessApi = {
      entries: () => {
        throw new Error('no snapshot expected');
      },
      startedAt: () => null,
    };
    expect(await queryProcesses({}, { native: untouchable, platform: 'win32' })).toEqual({
      kind: 'ok',
      processes: [],
    });
    await expect(queryProcesses({ parentPids: [0] }, { native, platform: 'win32' })).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  windowsOnly('the real snapshot finds this process with its parent and start time', () => {
    const api = loadNativeProcessApi();
    if (process.arch !== 'x64') return;
    expect(api).not.toBeNull();
    const me = api?.entries()?.find((entry) => entry.pid === process.pid);
    expect(me?.parentPid).toBe(process.ppid);
    expect(me?.name.toLowerCase()).toBe('node.exe');
    const started = api?.startedAt(process.pid)?.getTime() ?? 0;
    expect(Math.abs(started - (Date.now() - process.uptime() * 1000))).toBeLessThan(5_000);
    expect(api?.startedAt(0)).toBeNull();
  });

  it.runIf(process.platform === 'linux')(
    'Linux: the real /proc table finds this process with parent, comm and start time (WP-103)',
    () => {
      const api = loadNativeProcessApi();
      expect(api).not.toBeNull();
      const me = api?.entries()?.find((entry) => entry.pid === process.pid);
      expect(me?.parentPid).toBe(process.ppid);
      expect(me?.name).toBe(nodeImageName());
      // btime has whole seconds: up to 1 s early; the reading itself is deterministic.
      const started = api?.startedAt(process.pid)?.getTime() ?? 0;
      expect(Math.abs(started - (Date.now() - process.uptime() * 1000))).toBeLessThan(5_000);
      expect(api?.startedAt(process.pid)?.getTime()).toBe(started);
      expect(me?.startedAt?.getTime()).toBe(started);
      expect(api?.startedAt(0)).toBeNull();
    },
  );

  it('loadNativeProcessApi: /proc on Linux, nothing on other POSIX platforms', () => {
    expect(loadNativeProcessApi('darwin')).toBeNull();
    expect(loadNativeProcessApi('linux')).not.toBeNull();
  });
});

describe('listProcesses / descendantsOf (heartbeat snapshot, WP22-06)', () => {
  const at = (s: number) => new Date(Date.parse('2026-10-15T12:00:00.000Z') + s * 1000);
  const p = (pid: number, parentPid: number | null, s: number, name = 'x.exe') => ({
    pid,
    name,
    parentPid,
    startedAt: at(s),
  });

  it('descendants by ParentProcessId over all levels; a "child" older than its parent is a reused PID', () => {
    const claude = p(100, 1, 0, 'claude.exe');
    const list = [
      claude,
      p(200, 100, 1, 'cmd.exe'),
      p(300, 200, 2, 'powershell.exe'),
      p(400, 300, 3, 'PING.EXE'),
      p(201, 100, 1, 'node.exe'),
      // ParentProcessId 100 of a process that started BEFORE the claude.exe: an older owner of PID 100.
      p(500, 100, -10, 'stale.exe'),
      p(501, 500, -9, 'stale-child.exe'),
      p(900, 1, 5, 'other.exe'),
    ];
    expect(
      descendantsOf(list, claude)
        .map((x) => x.pid)
        .sort(),
    ).toEqual([200, 201, 300, 400]);
    // A dead intermediate parent: the grandchild still hangs at its (now missing) parent PID.
    expect(descendantsOf([claude, p(300, 200, 2)], claude)).toEqual([]);
    // Cycles do not loop.
    expect(descendantsOf([p(1, 2, 0), p(2, 1, 0)], p(1, 2, 0)).map((x) => x.pid)).toEqual([2]);
  });

  nativeHost(
    'the real listing finds this test process and the grandchild below a child',
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
      const result = await listProcesses();
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      const self = result.processes.find((x) => x.pid === process.pid);
      if (self === undefined) throw new Error('own process not listed');
      expect(descendantsOf(result.processes, self).map((x) => x.pid)).toEqual(
        expect.arrayContaining([pid, grandchild]),
      );
    },
    QUERY_TEST_TIMEOUT_MS,
  );
});
