/**
 * Pure helpers of the session engine around the registry entry (WP-13 §3.5.8, §3.5.9, §5.2):
 * `summaryOf` (schema-true SessionSummary, every field explicit for the hub validation), title
 * rules (prompt title, `title_changed` table, AI title from getSessionInfo), `/rename` parsing and
 * the conversation helpers of `/clear` (F.7, F.8, C.6, R0-05e).
 */
import path from 'node:path';
import { LIMITS, type ConversationId } from '@shared/common';
import {
  currentConversation,
  currentSessionId,
  type Conversation,
  type ConversationEndReason,
  type Entry,
  type SessionSummary,
  type TitleSource,
} from '@shared/model';
import type { StatusFacts } from '@shared/status';
import type { BackendSessionInfo } from '../backend/types';

/** Prompt titles are cut at a word boundary to this length (+ "…"). */
export const PROMPT_TITLE_CHARS = 80;

export function summaryOf(
  entry: Entry,
  facts: StatusFacts,
  extra: { gitBranch: string | null },
): SessionSummary {
  return {
    entryId: entry.id,
    title: entry.title,
    titleSource: entry.titleSource,
    profileId: entry.profileId,
    cwd: entry.cwd,
    pinned: entry.pinned,
    archived: entry.archived,
    createdAt: entry.createdAt,
    lastActivityAt: entry.lastActivityAt,
    status: facts,
    model: entry.lastModel,
    modelSetting: entry.modelSetting,
    permissionMode: entry.permissionMode,
    effort: entry.effort,
    fastMode: entry.fastMode,
    context: entry.context,
    sessionId: currentSessionId(entry),
    cliVersion: entry.cliVersion,
    apiKeySource: entry.apiKeySource,
    gitBranch: extra.gitBranch,
    lastError: entry.lastError,
    lastResultExcerpt: entry.lastResultExcerpt,
  };
}

export function capTitle(title: string): string {
  return title.slice(0, LIMITS.titleChars);
}

/** First non-empty line, whitespace collapsed, ≤ 80 chars at a word boundary (+ "…"); null for slash commands/empty. */
export function titleFromPrompt(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.startsWith('/')) return null;
  const line = trimmed
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find((l) => l !== '');
  if (line === undefined) return null;
  if (line.length <= PROMPT_TITLE_CHARS) return line;
  const cut = line.slice(0, PROMPT_TITLE_CHARS);
  const space = cut.lastIndexOf(' ');
  const head = (space >= PROMPT_TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd();
  return `${head}…`;
}

/** `/rename X` → `X` (title); `/rename` alone or another text → null. */
export function parseRenameCommand(text: string): string | null {
  const match = /^\/rename(?:\s+([\s\S]+))?$/.exec(text.trim());
  const title = match?.[1]?.trim();
  return title === undefined || title === '' ? null : capTitle(title.replace(/\s+/g, ' '));
}

export interface TitleContext {
  titleSource: TitleSource;
  pendingRename: string | null;
  /** A turn after a conversation_reset is running (the CLI echoes the old title, clear-rename#40/41). */
  resetInTurn: boolean;
}

export type TitleDecision =
  | { kind: 'set'; title: string; titleSource: 'custom' | 'ai'; echo: boolean }
  | { kind: 'ignore'; reason: 'custom' | 'reset' | 'empty' };

/** `title_changed` (R0-05e, architecture §5.2). */
export function titleChangeDecision(ctx: TitleContext, rawTitle: string): TitleDecision {
  const title = capTitle(rawTitle.trim());
  if (ctx.pendingRename !== null && ctx.pendingRename === title) {
    return { kind: 'set', title, titleSource: 'custom', echo: true };
  }
  if (title === '') return { kind: 'ignore', reason: 'empty' };
  if (ctx.titleSource === 'custom') return { kind: 'ignore', reason: 'custom' };
  if (ctx.resetInTurn) return { kind: 'ignore', reason: 'reset' };
  return { kind: 'set', title, titleSource: 'ai', echo: false };
}

/** Title sources the AI title query may replace (C.6). */
export function acceptsAiTitle(titleSource: TitleSource): boolean {
  return titleSource === 'none' || titleSource === 'prompt' || titleSource === 'ai';
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
const stripEllipsis = (text: string): string => text.replace(/(?:…|\.\.\.)$/, '').trimEnd();

/** True if the session info `summary` is just the first prompt (the SDK's fallback). */
export function isPromptFallback(
  summary: string,
  firstPrompt: string | null,
  promptTitle: string | null,
): boolean {
  const s = collapse(summary);
  if (firstPrompt !== null) {
    const fp = collapse(firstPrompt);
    if (s === fp) return true;
    const head = stripEllipsis(s);
    return head !== s && head !== '' && fp.startsWith(head);
  }
  // Heuristic without firstPrompt (§3.5.8): the summary starts with the prompt title.
  if (promptTitle === null) return false;
  const head = stripEllipsis(collapse(promptTitle));
  return head !== '' && s.startsWith(head);
}

/** AI title from getSessionInfo, or null if it must not be taken over (§3.5.8). */
export function aiTitleFrom(
  info: BackendSessionInfo | null,
  current: { title: string; titleSource: TitleSource; promptTitle: string | null },
): string | null {
  if (info?.customTitle !== null || !acceptsAiTitle(current.titleSource)) return null;
  const title = capTitle(collapse(info.summary));
  if (title === '' || title === current.title) return null;
  if (isPromptFallback(info.summary, info.firstPrompt, current.promptTitle)) return null;
  return title;
}

/** conversation_reset trigger → endReason of the ended conversation. */
export function endReasonFor(trigger: string | null): ConversationEndReason {
  return trigger === 'clear' || trigger === 'plan_mode_exit' ? trigger : 'unknown';
}

export function newConversation(
  id: ConversationId,
  startedAt: string,
  resetCorrelationId: string | null = null,
): Conversation {
  return {
    id,
    sessionId: null,
    startedAt,
    endedAt: null,
    endReason: null,
    title: null,
    resetCorrelationId,
    costUsd: null,
    lastOrder: 0,
  };
}

/** The entry with the current (last) conversation replaced by `patch(current)`. */
export function withCurrentConversation(entry: Entry, patch: (c: Conversation) => Conversation): Entry {
  const current = currentConversation(entry);
  return { ...entry, conversations: [...entry.conversations.slice(0, -1), patch(current)] };
}

/** Last path segment of a cwd, for notification titles of untitled entries. */
export function cwdLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  return path.win32.basename(trimmed) || cwd;
}

/** Plan approval after a restart (A.10, diagram g): the prompt that resumes the work. */
export function implementPlanPrompt(planFilePath: string | null, plan: string): string {
  return planFilePath === null ? `Implement this plan:\n\n${plan}` : `Implement the plan in ${planFilePath}`;
}
