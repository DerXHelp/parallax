/**
 * "What's new" (WP-87 §1.6, `GET /api/changelog`): the sections of a CHANGELOG.md for the UI.
 * - installed: `<repoRoot>\CHANGELOG.md` of the running version (listed in its package; in a
 *   checkout the repo's file) – with `since` the sections after that version, else its own;
 * - available: the signed CHANGELOG.md of the offered version (`github`: the asset checked against
 *   latest.json in the check, kept in memory; `file`: the one in its version folder, hashed by its
 *   release.json) – the sections between the running and that version, for a downgrade only its
 *   own; without a usable file (or no section) the `notes` of latest.json.
 * The selection rules are `@shared/changelog`; pre-releases use "Unveröffentlicht" like the release
 * scripts. Rendered by the UI as Markdown without raw HTML.
 */
import path from 'node:path';
import {
  changelogNotes,
  parseChangelog,
  releaseSection,
  sectionsBetween,
  type ChangelogNotes,
} from '@shared/changelog';
import { changelogSectionSchema, type ChangelogSection } from '@shared/http';
import { CHANGELOG_ASSET_MAX_BYTES } from './latest';
import { readFixedText } from './notices';

export const CHANGELOG_FILE = 'CHANGELOG.md';
/** `changelogResponseSchema`: at most 100 sections of at most 200 000 characters. */
const MAX_SECTIONS = 100;
const MAX_BODY_CHARS = 200_000;

/** Notes → wire sections (limits of the schema; a section the schema refuses is left out). */
function toSections(notes: readonly ChangelogNotes[]): ChangelogSection[] {
  const out: ChangelogSection[] = [];
  for (const note of notes) {
    if (out.length >= MAX_SECTIONS) break;
    const parsed = changelogSectionSchema.safeParse({ ...note, body: note.body.slice(0, MAX_BODY_CHARS) });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** `<dir>\CHANGELOG.md` (≤ 2 MiB); throws `CommandError` FILE_NOT_FOUND / PAYLOAD_TOO_LARGE. */
export function readChangelogFile(dir: string): Promise<string> {
  return readFixedText(path.join(dir, CHANGELOG_FILE), CHANGELOG_ASSET_MAX_BYTES);
}

/** The running version's notes: with `since` the sections after it, else its own section. */
export function installedNotes(text: string, running: string, since: string | undefined): ChangelogSection[] {
  const changelog = parseChangelog(text);
  if (since !== undefined) return toSections(sectionsBetween(changelog, since, running));
  const own = releaseSection(changelog, running);
  return own === undefined ? [] : toSections([changelogNotes(own)]);
}

export interface AvailableNotesInput {
  running: string;
  target: string;
  downgrade: boolean;
  /** The signed CHANGELOG.md of the target, or null. */
  text: string | null;
  /** latest.json `notes` (github), null for a file. */
  fallback: string | null;
}

/** The notes of the offered version (see the file comment). */
export function availableNotes(input: AvailableNotesInput): ChangelogSection[] {
  if (input.text !== null) {
    const changelog = parseChangelog(input.text);
    let notes: ChangelogNotes[];
    if (input.downgrade) {
      const own = releaseSection(changelog, input.target);
      notes = own === undefined ? [] : [changelogNotes(own)];
    } else {
      notes = sectionsBetween(changelog, input.running, input.target);
    }
    if (notes.length > 0 || input.fallback === null) return toSections(notes);
  }
  if (input.fallback === null) return [];
  return toSections([{ version: input.target, date: null, body: input.fallback }]);
}
