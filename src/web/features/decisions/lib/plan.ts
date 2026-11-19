import type { PermissionMode } from '@shared/common';
import { clipText as clip, plainInline } from '@web/lib/plain-text';

/**
 * Plan helpers (Plan "Plan-Modus & Plan-Freigabe"): title and short summary of a plan card from
 * the plan Markdown, and the order of the "Implement" options. Plain text only – the full plan is
 * rendered through the `Markdown` slot (never raw HTML).
 */

const TITLE_MAX = 120;
const SUMMARY_MAX = 240;

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

/**
 * From this context fill (%, same source as the plan bar's gauge) the "With fresh context" option
 * is highlighted as recommended (Plan "hervorgehoben, sobald die Context-Gauge über 60 % liegt",
 * ADR-147) – never chosen automatically.
 */
export const FRESH_CONTEXT_RECOMMENDED_PERCENT = 60;

export function isFreshContextRecommended(percent: number | null): boolean {
  return percent !== null && percent >= FRESH_CONTEXT_RECOMMENDED_PERCENT;
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
 * Mode of the main "Implement" button (WP-74, ADR-204): auto mode when offered (the model supports
 * it), else "accept edits", else the first offered mode. Bypass is never the default; a choice in
 * the menu holds for this plan only.
 */
export function defaultApproveMode(approveModes: readonly PermissionMode[]): PermissionMode | null {
  const ordered = orderedApproveModes(approveModes);
  if (ordered.includes('auto')) return 'auto';
  if (ordered.includes('acceptEdits')) return 'acceptEdits';
  return ordered.find((mode) => mode !== 'bypassPermissions') ?? ordered[0] ?? null;
}
