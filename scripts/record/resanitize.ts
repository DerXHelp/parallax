/**
 * `pnpm record --resanitize [scenario…]`: rebuilds test/fixtures/sdk/<scenario>.jsonl from the
 * newest raw recording in .recordings/<stamp>/<scenario>.raw.jsonl with the current sanitizer.
 * Only runs `claude auth status` (to know which account values to replace), no session.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeExecutable, FIXTURES_DIR, readAuthStatus, RECORDINGS_ROOT, secretsFor } from './context';
import { buildSpikeEnv } from './env';
import { createSanitizer } from './sanitize';
import { resanitizeRaw } from './writer';

/** Newest raw recording per scenario: scenario -> file. */
export function latestRawRecordings(): Map<string, string> {
  const latest = new Map<string, string>();
  if (!existsSync(RECORDINGS_ROOT)) return latest;
  const stamps = readdirSync(RECORDINGS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const stamp of stamps) {
    for (const file of readdirSync(path.join(RECORDINGS_ROOT, stamp))) {
      const match = /^(.+)\.raw\.jsonl$/.exec(file);
      const scenario = match?.[1];
      if (scenario !== undefined && !latest.has(scenario))
        latest.set(scenario, path.join(RECORDINGS_ROOT, stamp, file));
    }
  }
  return latest;
}

export async function resanitize(names: readonly string[]): Promise<number> {
  const auth = await readAuthStatus(claudeExecutable(), buildSpikeEnv(process.env).env);
  const secrets = secretsFor(auth);
  const latest = latestRawRecordings();
  const targets = names.length > 0 ? names : [...latest.keys()];
  let failures = 0;
  for (const name of targets) {
    const file = latest.get(name);
    if (file === undefined) {
      process.stderr.write(`resanitize: no raw recording for ${name}\n`);
      failures += 1;
      continue;
    }
    try {
      const text = resanitizeRaw(readFileSync(file, 'utf8'), createSanitizer(secrets), name);
      writeFileSync(path.join(FIXTURES_DIR, `${name}.jsonl`), text);
      process.stdout.write(`resanitize: ${name} <- ${path.relative(process.cwd(), file)}\n`);
    } catch (error) {
      process.stderr.write(
        `resanitize: ${name}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      failures += 1;
    }
  }
  return failures === 0 ? 0 : 1;
}
