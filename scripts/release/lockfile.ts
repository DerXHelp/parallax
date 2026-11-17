/**
 * Reads one package of `pnpm-lock.yaml` (pnpm 12, two YAML documents) without a YAML library:
 * the entry `'<name>@<version>':` of the `packages:` section with its `resolution.integrity`.
 * The lockfile knows no tarball URL (WP-83 §8.2); the installer asks the registry for it.
 */

export interface LockedPackage {
  name: string;
  version: string;
  integrity: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
}

/** The single locked version of `name`; throws if it is missing or locked more than once. */
export function lockedPackage(lockText: string, name: string): LockedPackage {
  // pnpm 12: the first document locks pnpm itself (packageManagerDependencies), the last the project.
  const documents = lockText.replace(/\r\n/gu, '\n').split(/^---$/mu);
  const text = documents[documents.length - 1] ?? '';
  const start = text.search(/^packages:$/mu);
  if (start === -1) throw new Error('pnpm-lock.yaml has no packages: section');
  const section = text.slice(start + 'packages:'.length);
  const end = section.search(/^\S/mu);
  const body = end === -1 ? section : section.slice(0, end);
  const pattern = new RegExp(
    `^ {2}'?${escapeRegExp(name)}@([^'():\\s]+)'?:\\n {4}resolution: \\{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\\}`,
    'gmu',
  );
  const matches = [...body.matchAll(pattern)];
  if (matches.length === 0) throw new Error(`${name} is not in the packages: section of pnpm-lock.yaml`);
  if (matches.length > 1) throw new Error(`${name} is locked in ${String(matches.length)} versions`);
  const [match] = matches;
  return { name, version: match?.[1] ?? '', integrity: match?.[2] ?? '' };
}
