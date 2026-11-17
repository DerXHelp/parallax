/**
 * Files of a release package (WP-85, docs/wp/WP-83.md §5.2/§7): only plain files - no links,
 * junctions, hardlinks, alternate data streams or names that differ only in case - and SHA-256 per
 * file. `scripts/release-pack.ts` writes the hashes into release.json; the installer (WP-86) checks
 * an unpacked package against them with `comparePackageFiles`, before it runs any of its code.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface PackageFile {
  /** `/`-separated path below the package root. */
  rel: string;
  size: number;
}

export interface PackageWalk {
  files: PackageFile[];
  problems: string[];
}

/** Every file below `root` (sorted by path) and every reason why the tree is not plain. */
export async function walkPackage(root: string): Promise<PackageWalk> {
  const files: PackageFile[] = [];
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const visit = async (dir: string, prefix: string): Promise<void> => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const key = rel.toLowerCase();
      const other = seen.get(key);
      if (other !== undefined) problems.push(`${rel}: differs from ${other} only in case`);
      seen.set(key, rel);
      if (name.includes(':')) problems.push(`${rel}: alternate data stream or invalid name`);
      const full = path.join(dir, name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) problems.push(`${rel}: link or junction`);
      else if (stat.isDirectory()) await visit(full, rel);
      else if (!stat.isFile()) problems.push(`${rel}: not a regular file`);
      else {
        if (stat.nlink > 1) problems.push(`${rel}: hardlink (${String(stat.nlink)} names)`);
        files.push({ rel, size: stat.size });
      }
    }
  };
  await visit(root, '');
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, problems };
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => {
        resolve(hash.digest('hex'));
      });
  });
}

/** `rel` → SHA-256 of every listed file (in list order). */
export async function hashFiles(
  root: string,
  files: readonly PackageFile[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of files) out[file.rel] = await sha256File(path.join(root, ...file.rel.split('/')));
  return out;
}

/**
 * Differences between an unpacked package (`walk`, `actual` hashes) and the signed list of
 * release.json: missing, changed and extra files (release.json and its signature are not listed).
 */
export function comparePackageFiles(
  walk: PackageWalk,
  actual: Readonly<Record<string, string>>,
  listed: Readonly<Record<string, string>>,
  ignore: readonly string[],
): string[] {
  const problems = [...walk.problems];
  const present = new Set(walk.files.map((file) => file.rel));
  for (const [rel, hash] of Object.entries(listed)) {
    if (!present.has(rel)) problems.push(`${rel}: missing`);
    else if (actual[rel] !== hash) problems.push(`${rel}: changed`);
  }
  for (const rel of present) {
    if (!(rel in listed) && !ignore.includes(rel)) problems.push(`${rel}: not in release.json`);
  }
  return problems;
}
