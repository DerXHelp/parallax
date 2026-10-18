/**
 * Who besides the current user can read `PARALLAX_HOME` (R2-13, warn only – no ACL change)?
 * The folder holds the launcher token (`server.lock.json`) and the cookie secret
 * (`auth-secret.json`). Under `%LOCALAPPDATA%` new folders inherit user-only ACLs; with `--home` on
 * another drive they often inherit "Authenticated Users: Modify" – on a multi-user/RDP machine
 * another user could then fetch sign-in codes or forge cookies (127.0.0.1 is reachable from every
 * session). `pnpm preflight` shows the result; the server logs a warning at start (wiring WP-20c).
 *
 * How (no localized names involved): the DACL as SDDL (`(Get-Acl -LiteralPath …).Sddl`, the path
 * goes through an environment variable – never into the script text) and the current user's SID
 * (`whoami /user /fo csv /nh`). Allow ACEs with read access (FILE_READ_DATA, GENERIC_READ/ALL) for
 * broad user groups (Everyone, Authenticated Users, Users, …) or any other account (`S-1-5-21-…`)
 * count as "shared". SYSTEM, Administrators, CREATOR OWNER, OWNER RIGHTS, services and app
 * containers do not. Deny ACEs are ignored (a warning may be too cautious, never too lax).
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { logger as rootLogger } from './logger';
import { fsErrorCode } from './paths';
import { powerShellPath, runFile, systemTool, type RunFileFn } from './process';

export type HomeAccess =
  /** Only the current user (plus SYSTEM/Administrators) can read it. */
  | { kind: 'private' }
  /** Readable by these principals (display labels or SIDs). */
  | { kind: 'shared'; principals: string[] }
  /** The folder does not exist yet. */
  | { kind: 'missing' }
  /** Not determinable (other platform, PowerShell/whoami failed, unreadable output). */
  | { kind: 'unknown'; reason: string };

export interface SddlAce {
  /** `A` allow, `D` deny, `OA`/`XA`/`ZA` object/callback allow … */
  type: string;
  flags: string[];
  /** Access mask (2-letter rights and hex both resolved). */
  mask: number;
  /** SID (aliases like `WD`/`AU` resolved to `S-1-…` where known, else the alias). */
  sid: string;
}

/** SDDL SID aliases → SIDs (the ones that matter for a data folder). */
const SDDL_SID_ALIASES: Readonly<Record<string, string>> = {
  WD: 'S-1-1-0',
  CO: 'S-1-3-0',
  CG: 'S-1-3-1',
  OW: 'S-1-3-4',
  NU: 'S-1-5-2',
  IU: 'S-1-5-4',
  SU: 'S-1-5-6',
  AN: 'S-1-5-7',
  AU: 'S-1-5-11',
  RC: 'S-1-5-12',
  SY: 'S-1-5-18',
  LS: 'S-1-5-19',
  NS: 'S-1-5-20',
  BA: 'S-1-5-32-544',
  BU: 'S-1-5-32-545',
  BG: 'S-1-5-32-546',
  PU: 'S-1-5-32-547',
  BO: 'S-1-5-32-551',
  RD: 'S-1-5-32-555',
  AC: 'S-1-15-2-1',
};

/** Broad groups that contain other users, with an English label for messages. */
const OTHER_USER_GROUPS: Readonly<Record<string, string>> = {
  'S-1-1-0': 'Everyone',
  'S-1-5-2': 'Network',
  'S-1-5-4': 'Interactive',
  'S-1-5-7': 'Anonymous',
  'S-1-5-11': 'Authenticated Users',
  'S-1-5-14': 'Remote Interactive Logon',
  'S-1-5-32-545': 'Users',
  'S-1-5-32-546': 'Guests',
  'S-1-5-32-547': 'Power Users',
  'S-1-5-32-555': 'Remote Desktop Users',
};

/** SDDL access-right letters → mask bits. */
const SDDL_RIGHTS: Readonly<Record<string, number>> = {
  GA: 0x10000000,
  GX: 0x20000000,
  GW: 0x40000000,
  GR: 0x80000000,
  RC: 0x00020000,
  SD: 0x00010000,
  WD: 0x00040000,
  WO: 0x00080000,
  CC: 0x00000001,
  DC: 0x00000002,
  LC: 0x00000004,
  SW: 0x00000008,
  RP: 0x00000010,
  WP: 0x00000020,
  DT: 0x00000040,
  LO: 0x00000080,
  CR: 0x00000100,
  FA: 0x001f01ff,
  FR: 0x00120089,
  FW: 0x00120116,
  FX: 0x001200a0,
  KA: 0x000f003f,
  KR: 0x00020019,
  KW: 0x00020006,
  KX: 0x00020019,
};

/** FILE_READ_DATA / LIST_DIRECTORY, GENERIC_READ, GENERIC_ALL. */
const READ_MASK = 0x00000001 | 0x80000000 | 0x10000000;
const ALLOW_TYPES: ReadonlySet<string> = new Set(['A', 'OA', 'XA', 'ZA']);

function rightsMask(rights: string): number {
  if (/^0x[0-9a-f]+$/i.test(rights)) return Number.parseInt(rights.slice(2), 16);
  let mask = 0;
  for (let i = 0; i < rights.length; i += 2) {
    // Unknown letters: assume read access (a warning too many beats one too few).
    mask |= SDDL_RIGHTS[rights.slice(i, i + 2)] ?? READ_MASK;
  }
  return mask >>> 0;
}

/** The ACE strings of the DACL part (`D:`…) of an SDDL string, or null if there is none. */
function daclAceStrings(sddl: string): string[] | null {
  const start = sddl.indexOf('D:');
  if (start < 0) return null;
  const aces: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = start + 2; i < sddl.length; i += 1) {
    const ch = sddl.charAt(i);
    if (depth === 0 && ch === 'S' && sddl.charAt(i + 1) === ':') break; // SACL follows
    if (ch === '(') {
      depth += 1;
      if (depth === 1) {
        current = '';
        continue;
      }
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        aces.push(current);
        continue;
      }
      if (depth < 0) return null;
    }
    if (depth > 0) current += ch;
  }
  return depth === 0 ? aces : null;
}

/** Parses the DACL of an SDDL string (tolerant: null if it has no readable DACL). */
export function parseSddlDacl(sddl: string): SddlAce[] | null {
  const strings = daclAceStrings(sddl.trim());
  if (strings === null) return null;
  const aces: SddlAce[] = [];
  for (const text of strings) {
    const [type, flags, rights, , , sid] = text.split(';');
    if (type === undefined || flags === undefined || rights === undefined || sid === undefined || sid === '')
      return null;
    aces.push({
      type,
      flags: flags.match(/.{1,2}/g) ?? [],
      mask: rightsMask(rights),
      sid: SDDL_SID_ALIASES[sid] ?? sid,
    });
  }
  return aces;
}

/** Principals other than `userSid` that may read (labels for well-known groups, else the SID). */
export function otherReaders(aces: readonly SddlAce[], userSid: string): string[] {
  const readers = new Set<string>();
  for (const ace of aces) {
    if (!ALLOW_TYPES.has(ace.type) || (ace.mask & READ_MASK) === 0) continue;
    const group = OTHER_USER_GROUPS[ace.sid];
    if (group !== undefined) readers.add(group);
    else if (ace.sid.startsWith('S-1-5-21-') && ace.sid.toUpperCase() !== userSid.toUpperCase())
      readers.add(ace.sid);
  }
  return [...readers];
}

/** SID from `whoami /user /fo csv /nh` (`"domain\user","S-1-5-21-…"`), or null. */
export function parseWhoamiSid(output: string): string | null {
  return /"(S-1-[0-9-]+)"\s*$/m.exec(output.trim())?.[1] ?? null;
}

export interface HomeAccessOptions {
  run?: RunFileFn;
  platform?: NodeJS.Platform;
  /** Per tool call (default 30 s). */
  timeoutMs?: number;
  /** Ends a running check (its process trees) → `unknown` 'aborted' (server shutdown, V3-15 b). */
  signal?: AbortSignal;
}

/** Checks the DACL of `home` (see the file comment). Never throws. */
export async function checkHomeAccess(home: string, options: HomeAccessOptions = {}): Promise<HomeAccess> {
  if ((options.platform ?? process.platform) !== 'win32') return { kind: 'unknown', reason: 'not Windows' };
  const run = options.run ?? runFile;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const signal = options.signal;
  const aborted = (): HomeAccess | null =>
    signal?.aborted === true ? { kind: 'unknown', reason: 'aborted' } : null;
  try {
    await stat(home);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unknown', reason: `not readable (${fsErrorCode(error) ?? 'error'})` };
  }
  try {
    const before = aborted();
    if (before !== null) return before;
    const whoami = await run(systemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    const afterWhoami = aborted();
    if (afterWhoami !== null) return afterWhoami;
    const userSid = whoami.exitCode === 0 ? parseWhoamiSid(whoami.stdout) : null;
    if (userSid === null) return { kind: 'unknown', reason: 'the user SID could not be read' };
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    env.PARALLAX_ACL_TARGET = path.resolve(home);
    const acl = await run(
      powerShellPath(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Acl -LiteralPath $env:PARALLAX_ACL_TARGET).Sddl',
      ],
      { timeoutMs, env, maxOutputBytes: 64 * 1024, ...(signal === undefined ? {} : { signal }) },
    );
    const afterAcl = aborted();
    if (afterAcl !== null) return afterAcl;
    if (acl.timedOut) return { kind: 'unknown', reason: 'Get-Acl timed out' };
    const aces = acl.exitCode === 0 ? parseSddlDacl(acl.stdout) : null;
    if (aces === null) return { kind: 'unknown', reason: `Get-Acl failed (exit ${String(acl.exitCode)})` };
    const principals = otherReaders(aces, userSid);
    return principals.length === 0 ? { kind: 'private' } : { kind: 'shared', principals };
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message.slice(0, 200) : 'error' };
  }
}

/**
 * For the server start (WP-20c, in the background after `listen`): logs a warning if other users
 * can read `home`, `debug` otherwise. Never throws.
 */
export async function logHomeAccess(
  home: string,
  options: HomeAccessOptions & { log?: Pick<typeof rootLogger, 'warn' | 'debug'> } = {},
): Promise<HomeAccess> {
  const log = options.log ?? rootLogger;
  const access = await checkHomeAccess(home, options);
  if (access.kind === 'shared') {
    log.warn(
      { home, readers: access.principals },
      'PARALLAX_HOME is readable by other users - it holds the launcher token and the cookie secret; ' +
        'use a folder only you can read (see pnpm preflight)',
    );
  } else {
    log.debug({ home, access }, 'PARALLAX_HOME access checked');
  }
  return access;
}
