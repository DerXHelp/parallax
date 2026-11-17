/**
 * Creates the release signing key (WP-85, docs/wp/WP-83.md §7). The USER runs it once in their own
 * terminal - never in a Claude session:
 *
 *   pnpm exec tsx --tsconfig tsconfig.tools.json scripts/release-key.ts --out <file outside the repo>
 *
 * - writes the private key (PKCS#8 PEM) to `--out` (must not exist, must be outside the repo);
 * - stores it as the secret RELEASE_SIGNING_KEY of the GitHub environment `release` (`gh secret set`
 *   reads it from stdin; `--no-secret` skips this);
 * - prints ONLY the public key and its fingerprint (for RELEASE_PUBLIC_KEYS in
 *   src/server/launcher/release.ts).
 * Afterwards: move the file into the password manager and delete it.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWindowsPathInside, windowsPathIssue } from '@shared/paths';
import { spawnHidden } from '../src/server/lib/process';
import { resolveExecutable } from '../src/server/lib/windows';

const REPO = 'DerXHelp/parallax';
const ENVIRONMENT = 'release';
const SECRET = 'RELEASE_SIGNING_KEY';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Runs gh with `input` on stdin (never echoed); resolves with its exit code and output. */
function gh(
  exe: string,
  args: readonly string[],
  input?: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnHidden(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr?.on('data', (chunk: string | Buffer) => (output += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, output: output.trim() });
    });
    child.stdin?.end(input ?? '');
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const outIndex = argv.indexOf('--out');
  const target = outIndex === -1 ? undefined : argv[outIndex + 1];
  const setSecret = !argv.includes('--no-secret');
  if (target === undefined) {
    out('usage: release-key.ts --out <file outside the repo> [--no-secret]');
    return 2;
  }
  const file = path.resolve(target);
  if (windowsPathIssue(file) !== null || isWindowsPathInside(file, repoRoot)) {
    out(`--out must be a plain local path outside the repo: ${file}`);
    return 2;
  }

  let ghExe: string | null = null;
  if (setSecret) {
    ghExe = await resolveExecutable('gh', process.env);
    if (ghExe === null) {
      out('gh.exe not found on the PATH (or use --no-secret and set the secret by hand)');
      return 1;
    }
    const env = await gh(ghExe, ['api', `repos/${REPO}/environments/${ENVIRONMENT}`, '--silent']);
    if (env.code !== 0) {
      out(`the GitHub environment "${ENVIRONMENT}" does not exist (or gh is not signed in): ${env.output}`);
      return 1;
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  // `wx`: never overwrite an existing key file.
  await writeFile(file, pem, { flag: 'wx', mode: 0o600 });
  out(`private key written to ${file}`);

  if (ghExe !== null) {
    const result = await gh(ghExe, ['secret', 'set', SECRET, '--env', ENVIRONMENT, '--repo', REPO], pem);
    if (result.code !== 0) {
      out(
        `gh secret set failed - set ${SECRET} of environment "${ENVIRONMENT}" by hand from the file: ${result.output}`,
      );
      return 1;
    }
    out(`secret ${SECRET} of environment "${ENVIRONMENT}" set`);
  }

  const x = publicKey.export({ format: 'jwk' }).x ?? '';
  const fingerprint = createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex');
  out('');
  out(`public key (RELEASE_PUBLIC_KEYS): ${x}`);
  out(`fingerprint (SHA-256): ${fingerprint.match(/.{1,8}/gu)?.join(' ') ?? fingerprint}`);
  out('');
  out('Next: move the key file into the password manager, then delete it. Give the public key to the');
  out('coordinator (it goes into src/server/launcher/release.ts).');
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    out(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
