/**
 * The two scans of the public-repo check (WP-84):
 * - `scanFiles`: the files of the working tree (`git ls-files`, plus untracked, not ignored ones);
 * - `scanRange`: what a push publishes – messages, author and committer addresses, branch and tag
 *   names, paths and the content of every blob in a revision range.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gitApi from './git';
import {
  containsPrivateTerm,
  environmentPatterns,
  isAllowedIdentityEmail,
  parsePrivateList,
  privateTermPatterns,
  scanText,
  type RuleId,
  type ScanContext,
} from './rules';

export interface Finding {
  /** Where: `path:line`, `commit <sha> message:line`, `commit <sha> author`, `ref <sha>`. */
  where: string;
  rule: RuleId;
}

export interface Context extends ScanContext {
  /** True if the local list was found (otherwise only the general rules apply). */
  hasPrivateList: boolean;
}

/** Binary files are not scanned (images, fonts, archives; any content with a NUL byte). */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.zip',
  '.pdf',
]);
const NUL_PROBE_BYTES = 8000;
const SHORT_SHA = 12;

/** Root of the checkout this script lives in (its path counts as private, also when scanning a clone). */
export const SCRIPT_CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function isBinary(file: string, content: Buffer): boolean {
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return true;
  return content.subarray(0, NUL_PROBE_BYTES).includes(0);
}

function currentUserName(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

/** Rules for `repo`: local list (or `listFile`), OS user name, the checkout paths. */
export async function loadContext(repo: string, options: { listFile?: string } = {}): Promise<Context> {
  const listText = await gitApi.readPrivateList(repo, options.listFile);
  const top = await gitApi.topLevel(repo);
  const mainCheckout = path.dirname(await gitApi.commonDir(repo));
  return {
    hasPrivateList: listText !== null,
    privateTerms: privateTermPatterns(listText === null ? [] : parsePrivateList(listText)),
    environment: environmentPatterns({
      userName: currentUserName(),
      checkoutPaths: [top, mainCheckout, SCRIPT_CHECKOUT],
    }),
  };
}

/** A path as printed: never with a term of the local list. */
function shownPath(file: string, context: ScanContext): string {
  return containsPrivateTerm(file, context) ? '<path hidden: private term>' : file;
}

function pathFindings(file: string, where: string, context: ScanContext): Finding[] {
  return scanText(file, context).map(({ rule }) => ({ where, rule }));
}

export async function scanFiles(repo: string, context: Context): Promise<Finding[]> {
  const top = await gitApi.topLevel(repo);
  const findings: Finding[] = [];
  for (const file of await gitApi.listFiles(top)) {
    const shown = shownPath(file, context);
    findings.push(...pathFindings(file, `${shown} (name)`, context));
    let content: Buffer;
    try {
      content = await readFile(path.join(top, file));
    } catch {
      continue; // deleted in the working tree, or a directory entry (submodule)
    }
    if (isBinary(file, content)) continue;
    for (const { line, rule } of scanText(content.toString('utf8'), context)) {
      findings.push({ where: `${shown}:${String(line)}`, rule });
    }
  }
  return findings;
}

export async function scanRange(
  repo: string,
  range: readonly string[],
  context: Context,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const commit of await gitApi.commits(repo, range)) {
    const sha = commit.sha.slice(0, SHORT_SHA);
    for (const { line, rule } of scanText(commit.message, context, { commitMessage: true })) {
      findings.push({ where: `commit ${sha} message:${String(line)}`, rule });
    }
    const people = [
      ['author', commit.authorName, commit.authorEmail],
      ['committer', commit.committerName, commit.committerEmail],
    ] as const;
    for (const [role, name, email] of people) {
      if (!isAllowedIdentityEmail(email))
        findings.push({ where: `commit ${sha} ${role} email`, rule: 'identity' });
      for (const { rule } of scanText(name, context))
        findings.push({ where: `commit ${sha} ${role} name`, rule });
    }
  }
  for (const ref of await gitApi.refs(repo)) {
    for (const { rule } of scanText(ref.name, context)) {
      findings.push({ where: `ref at ${ref.sha.slice(0, SHORT_SHA)} (name)`, rule });
    }
  }
  const entries = await gitApi.objects(repo, range);
  const paths = new Map<string, string>();
  const seenPaths = new Set<string>();
  for (const { sha, path: file } of entries) {
    if (file.length === 0) continue;
    if (!paths.has(sha)) paths.set(sha, file);
    if (seenPaths.has(file)) continue;
    seenPaths.add(file);
    findings.push(...pathFindings(file, `${shownPath(file, context)} (name)`, context));
  }
  const candidates = entries.filter((entry) => entry.path.length > 0).map((entry) => entry.sha);
  await gitApi.readBlobs(repo, [...new Set(candidates)], (sha, content) => {
    const file = paths.get(sha) ?? '';
    if (isBinary(file, content)) return;
    const shown = shownPath(file, context);
    for (const { line, rule } of scanText(content.toString('utf8'), context)) {
      findings.push({ where: `${shown}:${String(line)} (blob ${sha.slice(0, SHORT_SHA)})`, rule });
    }
  });
  return findings;
}

export function formatFinding(finding: Finding): string {
  return `${finding.where} [${finding.rule}]`;
}
