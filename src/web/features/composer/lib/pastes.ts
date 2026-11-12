import { LIMITS } from '@shared/common';

/**
 * Paste chips (ADR-146, WP-57): a large pasted text does not go into the field. A visible token
 * (`[#k · n lines]`, translated – like the CLI in the terminal) marks its place, a chip above the
 * field holds the text. Deleting the token drops the paste; sending replaces every token by its
 * text, and `prompt.pastes` lists each text exactly as it stands in the sent text (the server
 * checks `includes`, `paste_not_in_text`). Pure helpers – the draft store keeps the pastes.
 */

/** A pasted text from this many characters on becomes a chip … */
export const PASTE_CHIP_MIN_CHARS = 2000;
/** … or from this many lines on. */
export const PASTE_CHIP_MIN_LINES = 30;
/**
 * Text and pastes of one draft together (≈ 200 kB, counted in characters like the prompt limit):
 * a paste that would exceed it goes into the field as plain text, no chip (the draft is stored).
 */
export const DRAFT_PASTES_MAX_CHARS = 200_000;

export interface DraftPaste {
  /** `#k` – 1, 2, … within the draft. */
  id: number;
  /** The token in the field, exactly as inserted (in the language of that moment). */
  token: string;
  /** The pasted text (line breaks normalized to `\n`, as a textarea holds them). */
  text: string;
}

/** `\r\n` and `\r` → `\n`: what the field would contain after a normal paste. */
export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Lines of a text; a final line break starts no new line ("a\nb\n" = 2). */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** From 2 000 characters or 30 lines on a paste becomes a chip. */
export function isLargePaste(text: string): boolean {
  return text.length >= PASTE_CHIP_MIN_CHARS || lineCount(text) >= PASTE_CHIP_MIN_LINES;
}

/** The pastes whose token stands in `text`, in the order of their first token. */
export function activePastes(text: string, pastes: readonly DraftPaste[]): DraftPaste[] {
  return pastes
    .map((paste) => ({ paste, index: text.indexOf(paste.token) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.paste);
}

/** Next `#k` of a draft. */
export function nextPasteId(pastes: readonly DraftPaste[]): number {
  return pastes.reduce((max, paste) => Math.max(max, paste.id), 0) + 1;
}

/**
 * Why a large paste cannot become a chip: `count` = already `LIMITS.pastesMax` chips, `size` = the
 * draft would exceed `DRAFT_PASTES_MAX_CHARS`; null = it can.
 */
export function pasteRefusal(
  text: string,
  pastes: readonly DraftPaste[],
  incoming: string,
): 'count' | 'size' | null {
  const active = activePastes(text, pastes);
  if (active.length >= LIMITS.pastesMax) return 'count';
  const size = active.reduce((sum, paste) => sum + paste.text.length, text.length + incoming.length);
  return size > DRAFT_PASTES_MAX_CHARS ? 'size' : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Spaces and tabs right after a token (sticky: matched at `lastIndex`). */
const AFTER_TOKEN = /[ \t]*/y;

/**
 * The text to send: every token replaced by its paste (one pass – a paste that happens to contain
 * another token stays as it is). `pastes` = the distinct texts used, in order; each occurs verbatim
 * in `text`.
 *
 * V4-07: a paste that does not end with a line break gets one when the text goes on in the same
 * line – "[#1 · 40 lines] what is wrong?" sends the 40 lines and "what is wrong?" on a line of its
 * own (the spaces between token and text go), not glued to the last pasted line.
 */
export function expandPastes(
  text: string,
  pastes: readonly DraftPaste[],
): { text: string; pastes: string[] } {
  const active = activePastes(text, pastes);
  if (active.length === 0) return { text, pastes: [] };
  const byToken = new Map(active.map((paste) => [paste.token, paste]));
  const pattern = new RegExp(
    [...byToken.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|'),
    'g',
  );
  const used: string[] = [];
  let expanded = '';
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const paste = byToken.get(token);
    expanded += text.slice(last, match.index);
    last = match.index + token.length;
    if (paste === undefined) {
      expanded += token;
      continue;
    }
    if (!used.includes(paste.text)) used.push(paste.text);
    expanded += paste.text;
    if (paste.text.endsWith('\n')) continue;
    AFTER_TOKEN.lastIndex = last;
    const gap = AFTER_TOKEN.exec(text)?.[0].length ?? 0;
    const next = text.charAt(last + gap);
    if (next !== '' && next !== '\n') {
      expanded += '\n';
      last += gap;
    }
  }
  return { text: expanded + text.slice(last), pastes: used };
}

/**
 * Put in front of a prompt that would start with `/` only because of a paste (R5W-03): U+200B ZERO
 * WIDTH SPACE – invisible in the transcript, and unlike a space or a line break it survives every
 * `trim()` (CLI, server title and `/rename` detection), so the text never arrives as a command.
 */
export const SLASH_GUARD = '​';

/**
 * The prompt to send for a draft (`expandPastes`), R5W-03: a draft that does not start with `/`
 * itself never reaches the CLI as a slash command – when a paste token at its start expands to a
 * text beginning with `/` (a Unix path, a Git Bash log, a copied command), `SLASH_GUARD` goes in
 * front. A typed `/command [#1 …]` stays a command; the pastes still occur verbatim in the text.
 */
export function expandPrompt(
  text: string,
  pastes: readonly DraftPaste[],
): { text: string; pastes: string[] } {
  const expanded = expandPastes(text, pastes);
  if (text.trimStart().startsWith('/') || !expanded.text.trimStart().startsWith('/')) return expanded;
  return { text: `${SLASH_GUARD}${expanded.text}`, pastes: expanded.pastes };
}

/** The draft without the token(s) of `paste` ("Remove" on the chip). */
export function removePasteToken(text: string, paste: DraftPaste): string {
  return text.split(paste.token).join('');
}

/** "Convert to text": the token(s) become the pasted text; the caret goes after the first one. */
export function convertPaste(text: string, paste: DraftPaste): { text: string; caret: number } {
  const first = text.indexOf(paste.token);
  const next = text.split(paste.token).join(paste.text);
  return { text: next, caret: first < 0 ? next.length : first + paste.text.length };
}

/** Text and caret after inserting `insert` over the selection `[start, end)`. */
export function insertAt(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { text: `${text.slice(0, from)}${insert}${text.slice(to)}`, caret: from + insert.length };
}
