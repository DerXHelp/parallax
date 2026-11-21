/**
 * Signing step of the release CI (WP-85, docs/wp/WP-83.md §6/§7). Runs in the `sign` job, which
 * installs nothing: plain `node scripts/release/sign.ts …` (Node 26 strips the types), only
 * `node:` modules, no project code. The private key comes from the environment secret
 * RELEASE_SIGNING_KEY (PKCS#8 PEM) and is never printed.
 *
 *   node scripts/release/sign.ts sign <file>...
 *       writes <file>.sig: Ed25519 signature of the exact bytes, base64
 *   node scripts/release/sign.ts tarball <folder parallax-<v>> <parallax-<v>-linux-x64.tar.gz>
 *       packs the signed package folder for Linux (WP-108): ustar/pax, sorted, uid/gid 0, folders and
 *       the shell scripts 0755, other files 0644, every time the createdAt of its release.json, gzip
 *   node scripts/release/sign.ts latest --zip <zip> [--tarball <tar.gz>] --version <v> --release
 *       <release.json> --notes <md> --changelog <md> --out <json>
 *       writes latest.json (unsigned; sign it afterwards); `minNode` comes from the package's release.json
 *       (ADR-232: an installed version refuses a release for a newer Node before downloading it). The
 *       top level names the Windows zip (what versions before WP-108 read), `assets` every asset.
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { createWriteStream, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const REPO_DOWNLOADS = 'https://github.com/DerXHelp/parallax/releases/download';
const VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u;

function fail(message: string): never {
  process.stderr.write(`[sign] ${message}\n`);
  process.exit(1);
}

function signFiles(files: readonly string[]): void {
  const pem = process.env.RELEASE_SIGNING_KEY ?? '';
  if (!pem.includes('PRIVATE KEY')) fail('RELEASE_SIGNING_KEY is not set (environment "release")');
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') fail('RELEASE_SIGNING_KEY is not an Ed25519 key');
  if (files.length === 0) fail('no file to sign');
  for (const file of files) {
    const signature = sign(null, readFileSync(file), key).toString('base64');
    writeFileSync(`${file}.sig`, `${signature}\n`);
    process.stdout.write(`[sign] ${path.basename(file)}.sig written\n`);
  }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith('--')) fail(`missing ${name} <value>`);
  return value;
}

/** `minNode` of the package's release.json (`x.y.z`). */
function minNodeOf(file: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail(`${file} is not readable JSON`);
  }
  const minNode =
    typeof parsed === 'object' && parsed !== null && 'minNode' in parsed ? parsed.minNode : undefined;
  if (typeof minNode !== 'string' || !/^\d+\.\d+\.\d+$/u.test(minNode)) fail(`no valid minNode in ${file}`);
  return minNode;
}

// ---- tarball (WP-108) ----

/** Package files that keep the execute bit in the tarball (the shell scripts). */
const EXECUTABLES = new Set(['install.sh', 'root/parallax']);
const BLOCK = 512;

interface TarEntry {
  /** `/`-separated, below the root folder name; folders end with `/`. */
  name: string;
  file: string | null;
  size: number;
  mode: number;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** Splits `name` into ustar prefix and name, or null when it needs a pax header. */
function ustarName(name: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', name };
  for (let at = name.indexOf('/'); at !== -1; at = name.indexOf('/', at + 1)) {
    const prefix = name.slice(0, at);
    const rest = name.slice(at + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest !== '')
      return { prefix, name: rest };
  }
  return null;
}

function header(
  name: string,
  prefix: string,
  size: number,
  mode: number,
  type: string,
  mtime: number,
): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  const put = (text: string, at: number, width: number): void => {
    block.write(text.slice(0, width), at, width, 'utf8');
  };
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  put('        ', 148, 8);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK, 0);
}

/** A pax record `<len> path=<name>\n` (the length counts itself). */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length += 1;
  return `${String(length)}${body}`;
}

function headersOf(entry: TarEntry, mtime: number): Buffer[] {
  const type = entry.file === null ? '5' : '0';
  const split = ustarName(entry.name);
  if (split !== null) return [header(split.name, split.prefix, entry.size, entry.mode, type, mtime)];
  const pax = Buffer.from(paxRecord('path', entry.name), 'utf8');
  return [
    header(`PaxHeaders/${entry.name.slice(-80)}`, '', pax.length, 0o644, 'x', mtime),
    pax,
    padding(pax.length),
    header(entry.name.slice(0, 100), '', entry.size, entry.mode, type, mtime),
  ];
}

/** Every folder and plain file below `dir`, sorted; links and other types stop the run. */
function walk(dir: string, prefix: string, out: TarEntry[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = `${prefix}${name}`;
    if (!/^[\x20-\x7e]+$/u.test(name)) fail(`${rel}: name outside printable ASCII`);
    const info = lstatSync(full);
    if (info.isDirectory()) {
      out.push({ name: `${rel}/`, file: null, size: 0, mode: 0o755 });
      walk(full, `${rel}/`, out);
    } else if (info.isFile()) {
      out.push({ name: rel, file: full, size: info.size, mode: 0o644 });
    } else {
      fail(`${rel}: neither a plain file nor a folder`);
    }
  }
}

async function* tarChunks(entries: readonly TarEntry[], root: string, mtime: number): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    for (const part of headersOf(entry, mtime)) yield part;
    if (entry.file === null) continue;
    const bytes = await readFile(entry.file);
    if (bytes.length !== entry.size) fail(`${root}/${entry.name} changed while packing`);
    yield bytes;
    yield padding(bytes.length);
  }
  yield Buffer.alloc(BLOCK * 2, 0);
}

/** `createdAt` of the package's release.json in seconds (the same time for every entry). */
function packageTime(folder: string): number {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(folder, 'release.json'), 'utf8'));
    const created =
      typeof parsed === 'object' && parsed !== null && 'createdAt' in parsed ? parsed.createdAt : undefined;
    const ms = typeof created === 'string' ? Date.parse(created) : Number.NaN;
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  } catch {
    // checked below
  }
  return fail(`${folder} has no release.json with createdAt`);
}

async function writeTarball(args: readonly string[]): Promise<void> {
  const [folder, out] = args;
  if (folder === undefined || out === undefined) fail('usage: sign.ts tarball <folder> <out>');
  const root = path.basename(path.resolve(folder));
  const version = /^parallax-(.+)$/u.exec(root)?.[1];
  if (version === undefined || !VERSION.test(version)) fail(`${folder} is no folder parallax-<version>`);
  const asset = `parallax-${version}-linux-x64.tar.gz`;
  if (path.basename(out) !== asset) fail(`the tarball must be named ${asset}`);
  const mtime = packageTime(folder);
  const entries: TarEntry[] = [{ name: `${root}/`, file: null, size: 0, mode: 0o755 }];
  walk(folder, `${root}/`, entries);
  for (const entry of entries) {
    if (EXECUTABLES.has(entry.name.slice(root.length + 1))) entry.mode = 0o755;
  }
  await pipeline(
    Readable.from(tarChunks(entries, root, mtime)),
    createGzip({ level: 9 }),
    createWriteStream(out),
  );
  process.stdout.write(
    `[sign] ${asset} written (${String(entries.length)} entries, ${String(statSync(out).size)} bytes)\n`,
  );
}

// ---- latest.json ----

interface Asset {
  name: string;
  url: string;
  size: number;
  sha256: string;
}

function assetOf(file: string, name: string, version: string): Asset {
  if (path.basename(file) !== name) fail(`the asset must be named ${name}`);
  return {
    name,
    url: `${REPO_DOWNLOADS}/v${version}/${name}`,
    size: statSync(file).size,
    sha256: sha256(file),
  };
}

function writeLatest(args: readonly string[]): void {
  const version = option(args, '--version');
  if (!VERSION.test(version)) fail(`invalid version ${version}`);
  const zip = assetOf(option(args, '--zip'), `parallax-${version}-win.zip`, version);
  const assets = [zip];
  if (args.includes('--tarball')) {
    assets.push(assetOf(option(args, '--tarball'), `parallax-${version}-linux-x64.tar.gz`, version));
  }
  const latest = {
    schemaVersion: 1,
    version,
    prerelease: version.includes('-'),
    minNode: minNodeOf(option(args, '--release')),
    url: zip.url,
    size: zip.size,
    sha256: zip.sha256,
    changelogSha256: sha256(option(args, '--changelog')),
    notes: readFileSync(option(args, '--notes'), 'utf8').trim(),
    createdAt: new Date().toISOString(),
    assets,
  };
  writeFileSync(option(args, '--out'), `${JSON.stringify(latest, null, 2)}\n`);
  process.stdout.write(
    `[sign] latest.json for ${version} written (${assets.map((a) => `${a.name} ${String(a.size)} bytes`).join(', ')})\n`,
  );
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'sign') signFiles(rest);
else if (command === 'tarball') await writeTarball(rest);
else if (command === 'latest') writeLatest(rest);
else
  fail(
    'usage: sign.ts sign <file>... | sign.ts tarball <folder> <out> | sign.ts latest --zip … [--tarball …] --version … --release … --notes … --changelog … --out …',
  );
