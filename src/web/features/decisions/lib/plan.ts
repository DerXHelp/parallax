import type { PermissionMode } from '@shared/common';

/**
 * Plan helpers (Plan "Plan-Modus & Plan-Freigabe"): title and short summary of a plan card from
 * the plan Markdown, and the order of the "Implement" options. Plain text only – the full plan is
 * rendered through the `Markdown` slot (never raw HTML).
 */

const TITLE_MAX = 120;
const SUMMARY_MAX = 240;

/** Removes inline Markdown markers for a one-line plain-text label. */
function plainInline(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function lines(plan: string): string[] {
  return plan.replace(/\r\n?/g, '\n').split('\n');
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** First heading of the plan, else its first non-empty line; null for an empty plan. */
export function planTitle(plan: string): string | null {
  let inFence = false;
  for (const line of lines(plan)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.trim() === '') continue;
    const heading = HEADING.exec(line);
    const text = plainInline(heading?.[1] ?? line.replace(LIST_MARKER, ''));
    if (text !== '') return clip(text, TITLE_MAX);
  }
  return null;
}

/**
 * First paragraph (or the first list items) after the title as one plain-text line, else null.
 * Headings and code fences are skipped.
 */
export function planSummary(plan: string): string | null {
  const all = lines(plan);
  const title = planTitle(plan);
  const parts: string[] = [];
  let seenTitle = title === null;
  let inFence = false;
  for (const line of all) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const trimmed = line.trim();
    if (!seenTitle) {
      if (trimmed !== '') seenTitle = true;
      continue;
    }
    if (trimmed === '') {
      if (parts.length > 0) break;
      continue;
    }
    if (HEADING.test(line)) {
      if (parts.length > 0) break;
      continue;
    }
    parts.push(plainInline(trimmed.replace(LIST_MARKER, '')));
  }
  const summary = parts.filter((part) => part !== '').join(' · ');
  return summary === '' ? null : clip(summary, SUMMARY_MAX);
}

/** Display order of the "Implement" options (Plan: auto, accept edits, each change; bypass last). */
const APPROVE_ORDER: readonly PermissionMode[] = [
  'auto',
  'acceptEdits',
  'default',
  'dontAsk',
  'plan',
  'bypassPermissions',
];

/** The offered modes in display order (only those the server offers, C.4). */
export function orderedApproveModes(approveModes: readonly PermissionMode[]): PermissionMode[] {
  return APPROVE_ORDER.filter((mode) => approveModes.includes(mode));
}

/**
 * Mode of the main "Implement" button: the remembered choice if offered, else "accept edits"
 * (the CLI's own first choice), else the first offered mode. Bypass is never the default.
 */
export function defaultApproveMode(
  approveModes: readonly PermissionMode[],
  remembered: PermissionMode | null,
): PermissionMode | null {
  const ordered = orderedApproveModes(approveModes);
  if (remembered !== null && remembered !== 'bypassPermissions' && ordered.includes(remembered)) {
    return remembered;
  }
  if (ordered.includes('acceptEdits')) return 'acceptEdits';
  return ordered.find((mode) => mode !== 'bypassPermissions') ?? ordered[0] ?? null;
}
