/**
 * Signing step of the release CI (WP-85, docs/wp/WP-83.md §6/§7). Runs in the `sign` job, which
 * installs nothing: plain `node scripts/release/sign.ts …` (Node 26 strips the types), only
 * `node:` modules, no project code. The private key comes from the environment secret
 * RELEASE_SIGNING_KEY (PKCS#8 PEM) and is never printed.
 *
 *   node scripts/release/sign.ts sign <file>...
 *       writes <file>.sig: Ed25519 signature of the exact bytes, base64
 *   node scripts/release/sign.ts latest --zip <zip> --version <v> --notes <md> --changelog <md> --out <json>
 *       writes latest.json (unsigned; sign it afterwards)
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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

function writeLatest(args: readonly string[]): void {
  const zip = option(args, '--zip');
  const version = option(args, '--version');
  if (!VERSION.test(version)) fail(`invalid version ${version}`);
  const asset = `parallax-${version}-win.zip`;
  if (path.basename(zip) !== asset) fail(`the zip must be named ${asset}`);
  const latest = {
    schemaVersion: 1,
    version,
    prerelease: version.includes('-'),
    url: `${REPO_DOWNLOADS}/v${version}/${asset}`,
    size: statSync(zip).size,
    sha256: sha256(zip),
    changelogSha256: sha256(option(args, '--changelog')),
    notes: readFileSync(option(args, '--notes'), 'utf8').trim(),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(option(args, '--out'), `${JSON.stringify(latest, null, 2)}\n`);
  process.stdout.write(`[sign] latest.json for ${version} written (${String(latest.size)} bytes zip)\n`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'sign') signFiles(rest);
else if (command === 'latest') writeLatest(rest);
else
  fail('usage: sign.ts sign <file>... | sign.ts latest --zip … --version … --notes … --changelog … --out …');
