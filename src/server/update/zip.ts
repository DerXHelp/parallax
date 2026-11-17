/**
 * The release zip (WP-87 §2.1 steps 3–4, docs/wp/WP-83.md §7): listed and unpacked with
 * `System32\tar.exe` (bsdtar) – no own zip code. The listing (`tar -t -v -f`) is checked before
 * anything is unpacked:
 * - at most `ZIP_MAX_ENTRIES` entries and `ZIP_MAX_UNPACKED_BYTES` of file data (declared sizes);
 * - only files and folders (no links, hardlinks, devices);
 * - every entry below exactly `parallax-<version>/` – one root folder, no absolute path, no drive,
 *   no backslash, no `.`/`..`/empty segment.
 * Unpacking goes into a fresh, empty folder (bsdtar refuses `..` and absolute paths by itself).
 * What counts afterwards is the signed file list: install/install.ts `stageVersion` walks the
 * unpacked tree (links, data streams, case clashes), hashes every file against release.json and
 * copies only the content of listed files.
 *
 * The listing format is bsdtar's `ls -l` style: `<mode> <links> <owner> <group> <size> <date
 * (three fields)> <name>`; names are escaped (no raw newline). A line that does not parse makes
 * the package invalid – the check fails closed.
 */
import { appVersionSchema } from '@shared/model';
import { runFile, systemTool, type RunFileFn, type RunFileResult } from '../lib/process';

export const ZIP_MAX_ENTRIES = 20_000;
export const ZIP_MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
export const ZIP_LIST_TIMEOUT_MS = 2 * 60_000;
export const ZIP_EXTRACT_TIMEOUT_MS = 5 * 60_000;
/** stdout of the listing: ~150 bytes per entry; more means more entries than allowed. */
const LIST_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const OUTPUT_TAIL_CHARS = 400;

/** `UPDATE_INVALID_PACKAGE.reason` of a zip problem. */
export type ZipProblem = 'zip' | 'layout' | 'too_large';

export class ZipError extends Error {
  readonly reason: ZipProblem;
  constructor(reason: ZipProblem, message: string) {
    super(message);
    this.name = 'ZipError';
    this.reason = reason;
  }
}

export interface ZipListing {
  /** `parallax-<version>` */
  rootDir: string;
  version: string;
  entries: number;
  /** Sum of the declared file sizes. */
  bytes: number;
}

/** `<type><mode> <links> <owner> <group> <size> <rest>`; rest = date and name. */
const LINE = /^([-a-zA-Z?])[-a-zA-Z?]{9}\+?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(.+)$/u;
/** The usual date: three fields (`Nov 17 19:44`, `Nov 17  2025`), then one space and the name. */
const DATE_AND_NAME = /^\S+\s+\S+\s+\S+ (.+)$/u;
const ROOT = /^parallax-(.+)$/u;
const ROOT_MARK = ' parallax-';

/**
 * The name in `rest`: from the first ` parallax-` (every valid name starts so; the date never
 * contains it – this also covers a locale whose date has more or fewer fields), else after the
 * three date fields.
 */
function nameOf(rest: string): string | undefined {
  const mark = rest.indexOf(ROOT_MARK);
  if (mark !== -1) return rest.slice(mark + 1);
  return DATE_AND_NAME.exec(rest)?.[1];
}

/**
 * Checks the output of `tar -t -v -f <zip>`. `version` = the expected version (`parallax-<v>/`);
 * null = take it from the entries (Install from file) – it must be a release version. `names` = the
 * output of the plain `tar -t -f <zip>`: every name taken from a verbose line must be exactly the
 * name on the same line there (a name containing ` parallax-` cannot fake another root; security
 * review WP-89). Throws `ZipError`.
 */
export function parseZipListing(stdout: string, version: string | null, names?: string): ZipListing {
  const lines = stdout.split(/\r?\n/u).filter((line) => line !== '');
  const plain = names?.split(/\r?\n/u).filter((line) => line !== '');
  if (plain !== undefined && plain.length !== lines.length) {
    throw new ZipError('zip', 'the two listings of the zip differ');
  }
  if (lines.length === 0) throw new ZipError('zip', 'the zip is empty');
  if (lines.length > ZIP_MAX_ENTRIES) {
    throw new ZipError(
      'too_large',
      `the zip has ${String(lines.length)} entries (at most ${String(ZIP_MAX_ENTRIES)})`,
    );
  }
  let rootDir = version === null ? null : `parallax-${version}`;
  let bytes = 0;
  let index = 0;
  for (const line of lines) {
    const match = LINE.exec(line);
    const type = match?.[1];
    const size = match?.[2];
    const rest = match?.[3];
    const name = rest === undefined ? undefined : nameOf(rest);
    if (type === undefined || size === undefined || name === undefined) {
      throw new ZipError('zip', `unexpected listing line: ${line.slice(0, 200)}`);
    }
    if (plain !== undefined && plain[index] !== name) {
      throw new ZipError('layout', `${name.slice(0, 200)}: the two listings of the zip differ`);
    }
    index += 1;
    if (type !== '-' && type !== 'd') throw new ZipError('layout', `${name}: not a plain file or folder`);
    const isDir = type === 'd';
    const rel = isDir && name.endsWith('/') ? name.slice(0, -1) : name;
    if (rel.includes('\\') || rel.includes(':') || rel.startsWith('/')) {
      throw new ZipError('layout', `${name}: absolute path, drive or backslash`);
    }
    const parts = rel.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) {
      throw new ZipError('layout', `${name}: empty, "." or ".." path segment`);
    }
    const first = parts[0] ?? '';
    if (rootDir === null) {
      const candidate = ROOT.exec(first)?.[1];
      if (candidate === undefined || !appVersionSchema.safeParse(candidate).success) {
        throw new ZipError('layout', `${name}: not below parallax-<version>/`);
      }
      rootDir = first;
    }
    if (first !== rootDir) throw new ZipError('layout', `${name}: not below ${rootDir}/`);
    if (parts.length === 1 && !isDir)
      throw new ZipError('layout', `${name}: a file instead of the root folder`);
    if (!isDir) {
      bytes += Number(size);
      if (bytes > ZIP_MAX_UNPACKED_BYTES) {
        throw new ZipError(
          'too_large',
          `the zip unpacks to more than ${String(ZIP_MAX_UNPACKED_BYTES)} bytes`,
        );
      }
    }
  }
  if (rootDir === null) throw new ZipError('zip', 'the zip is empty');
  return { rootDir, version: rootDir.slice('parallax-'.length), entries: lines.length, bytes };
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL_CHARS ? `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed;
}

function failure(result: RunFileResult): string | null {
  if (result.timedOut) return 'timed out';
  if (result.exitCode === 0) return null;
  const code =
    result.exitCode === null ? `signal ${result.signal ?? '?'}` : `exit ${String(result.exitCode)}`;
  const output = tail(result.stderr);
  return output === '' ? code : `${code}: ${output}`;
}

export interface ZipToolOptions {
  /** Default `runFile`. */
  run?: RunFileFn;
  /** Ends tar.exe (whole tree) like a timeout, e.g. at the shutdown. */
  signal?: AbortSignal | undefined;
  /** Working directory of tar.exe (never a version folder). */
  cwd: string;
}

/** Lists `zip` with tar.exe and checks the listing (`parseZipListing`). Throws `ZipError`. */
export async function listZip(
  zip: string,
  version: string | null,
  options: ZipToolOptions,
): Promise<ZipListing> {
  const run = options.run ?? runFile;
  const list = async (args: readonly string[]): Promise<string> => {
    let result: RunFileResult;
    try {
      result = await run(systemTool('tar.exe'), [...args, '-f', zip], {
        cwd: options.cwd,
        timeoutMs: ZIP_LIST_TIMEOUT_MS,
        maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      throw new ZipError(
        'zip',
        `tar.exe could not be started: ${error instanceof Error ? error.message : 'error'}`,
      );
    }
    options.signal?.throwIfAborted();
    const problem = failure(result);
    if (problem !== null) throw new ZipError('zip', `tar.exe could not list the zip: ${problem}`);
    if (Buffer.byteLength(result.stdout, 'utf8') >= LIST_MAX_OUTPUT_BYTES) {
      throw new ZipError('too_large', 'the listing of the zip is too long');
    }
    return result.stdout;
  };
  // Verbose for types and sizes, plain for the exact names (parseZipListing compares both).
  const verbose = await list(['-t', '-v']);
  const names = await list(['-t']);
  return parseZipListing(verbose, version, names);
}

/** Unpacks `zip` into the existing, empty folder `target` (≤ 5 min). Throws `ZipError`. */
export async function extractZip(
  zip: string,
  target: string,
  options: Omit<ZipToolOptions, 'cwd'>,
): Promise<void> {
  const run = options.run ?? runFile;
  let result: RunFileResult;
  try {
    result = await run(systemTool('tar.exe'), ['-x', '-f', zip, '-C', target], {
      cwd: target,
      timeoutMs: ZIP_EXTRACT_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw new ZipError(
      'zip',
      `tar.exe could not be started: ${error instanceof Error ? error.message : 'error'}`,
    );
  }
  options.signal?.throwIfAborted();
  const problem = failure(result);
  if (problem !== null) throw new ZipError('zip', `tar.exe could not unpack the zip: ${problem}`);
}
