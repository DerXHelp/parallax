/**
 * Start-chunk budget of the web build (FIX-R5-F6; method of WP-60 §2.5 and R5-web R5W-01). Reads
 * only `dist/web` – run `pnpm build` first; it never builds, writes or starts anything.
 *
 * Start chunks = the entry script plus every `<link rel="modulepreload">` of `dist/web/index.html`
 * (what the browser loads before the first render). Sizes per file and in sum: raw bytes and gzip
 * (zlib level 9 – the same numbers as the measurements in docs/wp/WP-60.md, FIX-R5-F3/F5/F6).
 *
 * Checks (exit code 1 when one fails):
 * - `index-*.js` grows by at most 10 kB raw against the base (WP-60 §1 Nr. 11; base `109c073` until
 *   WP-70, since then `2fe8a9b`, ADR-193 – a new base only with an ADR);
 * - the sum of all start chunks grows by at most 10 kB raw against the same base (R5W-01 counts
 *   every start chunk, so a module moved from `index` into a new start chunk is no saving);
 * - no `dictionary.*` chunk (the non-English dictionaries, ADR-153) is a start chunk.
 * Exit code 2: no build (or an unreadable index.html).
 *
 *   pnpm exec tsx --tsconfig tsconfig.tools.json scripts/bundle-budget.ts           # table + checks
 *   pnpm exec tsx --tsconfig tsconfig.tools.json scripts/bundle-budget.ts --lazy    # + largest lazy chunks
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(repoRoot, 'dist', 'web');

/**
 * Base (ADR-193): the merge of WP-70 `2fe8a9b` – `index` and the sum of its 9 start chunks. Before:
 * WP-60 `109c073` (docs/wp/WP-60.md §2.5; index 383,072 / start 879,955 raw, 4 start chunks).
 */
const BASE = {
  commit: '2fe8a9b',
  indexRaw: 323_111,
  indexGzip: 95_889,
  startRaw: 889_270,
  startGzip: 269_372,
};
/** Allowed growth against BASE, raw bytes. */
const GROWTH_RAW = 10_000;
/** Lazy chunks listed with `--lazy`. */
const LAZY_LISTED = 20;

interface Chunk {
  file: string;
  raw: number;
  gzip: number;
}

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const bytes = (value: number): string => value.toLocaleString('en-US');
const delta = (value: number): string => `${value >= 0 ? '+' : ''}${bytes(value)}`;

async function measure(file: string): Promise<Chunk> {
  const content = await readFile(path.join(webRoot, file));
  return { file, raw: content.length, gzip: gzipSync(content, { level: 9 }).length };
}

/** Entry script and modulepreloads of index.html, as paths below dist/web (`assets/…`). */
function startFiles(html: string): string[] {
  const files: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="\/([^"]+\.js)"/g)) {
    if (match[1] !== undefined) files.push(match[1]);
  }
  for (const match of html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="\/([^"]+\.js)"/g)) {
    if (match[1] !== undefined && !files.includes(match[1])) files.push(match[1]);
  }
  return files;
}

function line(name: string, raw: string, gzip: string): string {
  return `${name.padEnd(36)} ${raw.padStart(10)} ${gzip.padStart(10)}`;
}

function row(name: string, raw: number, gzip: number): string {
  return line(name, bytes(raw), bytes(gzip));
}

async function main(): Promise<number> {
  let html: string;
  try {
    html = await readFile(path.join(webRoot, 'index.html'), 'utf8');
  } catch {
    process.stderr.write(`[bundle] no build in ${webRoot} - run pnpm build first\n`);
    return 2;
  }
  const files = startFiles(html);
  const entry = files[0];
  if (entry === undefined || !/(^|\/)index-[\w-]+\.js$/.test(entry)) {
    process.stderr.write('[bundle] index.html names no index-*.js entry script\n');
    return 2;
  }
  const chunks = await Promise.all(files.map(measure));
  const index = chunks[0];
  if (index === undefined) return 2;
  const startRaw = chunks.reduce((sum, chunk) => sum + chunk.raw, 0);
  const startGzip = chunks.reduce((sum, chunk) => sum + chunk.gzip, 0);

  out(`Start chunks of dist/web (entry + modulepreload), bytes; base ${BASE.commit}`);
  out(line('file', 'raw', 'gzip -9'));
  for (const chunk of chunks) out(row(chunk.file, chunk.raw, chunk.gzip));
  out(row(`sum (${String(chunks.length)} files)`, startRaw, startGzip));
  out();
  out(
    `index: ${delta(index.raw - BASE.indexRaw)} raw / ${delta(index.gzip - BASE.indexGzip)} gzip against ${BASE.commit}`,
  );
  out(
    `start: ${delta(startRaw - BASE.startRaw)} raw / ${delta(startGzip - BASE.startGzip)} gzip against ${BASE.commit} (${String(chunks.length)} files)`,
  );

  if (process.argv.includes('--lazy')) {
    const all = (await readdir(path.join(webRoot, 'assets'))).filter((file) => file.endsWith('.js'));
    const lazy = all.map((file) => `assets/${file}`).filter((file) => !files.includes(file));
    const measured = (await Promise.all(lazy.map(measure))).sort((a, b) => b.raw - a.raw);
    out();
    out(
      `Largest lazy chunks (${String(Math.min(LAZY_LISTED, measured.length))} of ${String(measured.length)})`,
    );
    for (const chunk of measured.slice(0, LAZY_LISTED)) out(row(chunk.file, chunk.raw, chunk.gzip));
  }

  const failures: string[] = [];
  if (index.raw > BASE.indexRaw + GROWTH_RAW) {
    failures.push(`index grows by ${bytes(index.raw - BASE.indexRaw)} B raw (budget ${bytes(GROWTH_RAW)})`);
  }
  if (startRaw > BASE.startRaw + GROWTH_RAW) {
    failures.push(
      `start chunks grow by ${bytes(startRaw - BASE.startRaw)} B raw (budget ${bytes(GROWTH_RAW)})`,
    );
  }
  const dictionaries = files.filter((file) => /(^|\/)dictionary\.[\w.-]+\.js$/.test(file));
  if (dictionaries.length > 0) {
    failures.push(`dictionary chunk(s) in the start bundle (ADR-153): ${dictionaries.join(', ')}`);
  }
  out();
  if (failures.length === 0) {
    out('[bundle] OK - within budget');
    return 0;
  }
  for (const failure of failures) out(`[bundle] OVER BUDGET: ${failure}`);
  return 1;
}

process.exitCode = await main();
