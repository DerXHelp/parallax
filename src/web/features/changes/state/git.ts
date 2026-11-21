import { useCallback, useEffect, useState } from 'react';
import { parseSessionKey, type EntryId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { GitDiffFile, GitDiffScope, GitStatus, ReviewComment } from '@shared/model';
import type { CommandResult } from '@shared/protocol';
import { ClientCommandError, errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSummarySelector } from '@web/state/hooks';

/**
 * Git service and review store of the tab "Changes" (WP-113, ADR-252…254): every command goes to the
 * host of the session (`sendCommand` routes by the session key – another computer's session too).
 * `useChangesData` loads status and diff list when the tab opens, after every turn end of the session,
 * when HEAD moves (the branch in the summary), on "Refresh" and after every action of the panel.
 */

function entryOf(sessionKey: string): EntryId {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) throw new ClientCommandError(makeError('VALIDATION_FAILED', { path: 'sessionKey' }));
  return parsed.entryId;
}

export type GitDiffList = CommandResult<'git.diff'>;

// ---- git commands ----

export async function fetchGitStatus(sessionKey: string): Promise<GitStatus> {
  const { status } = await sendCommand(sessionKey, { name: 'git.status', entryId: entryOf(sessionKey) });
  return status;
}

export function fetchGitDiff(
  sessionKey: string,
  scope: GitDiffScope,
  onlySessionFiles: boolean,
): Promise<GitDiffList> {
  return sendCommand(sessionKey, { name: 'git.diff', entryId: entryOf(sessionKey), scope, onlySessionFiles });
}

export async function fetchFileDiff(
  sessionKey: string,
  scope: GitDiffScope,
  path: string,
): Promise<GitDiffFile> {
  const { file } = await sendCommand(sessionKey, {
    name: 'git.fileDiff',
    entryId: entryOf(sessionKey),
    scope,
    path,
  });
  return file;
}

/** `paths` undefined = everything (`git commit` of all changes). Resolves to the new commit. */
export async function commitChanges(
  sessionKey: string,
  message: string,
  paths: readonly string[] | undefined,
): Promise<string> {
  const { sha } = await sendCommand(sessionKey, {
    name: 'git.commit',
    entryId: entryOf(sessionKey),
    message,
    ...(paths === undefined || paths.length === 0 ? {} : { paths: [...paths] }),
  });
  return sha;
}

export async function createBranch(sessionKey: string, branch: string, switchTo: boolean): Promise<void> {
  await sendCommand(sessionKey, {
    name: 'git.branchCreate',
    entryId: entryOf(sessionKey),
    branch,
    switch: switchTo,
  });
}

export async function switchBranch(sessionKey: string, branch: string): Promise<void> {
  await sendCommand(sessionKey, { name: 'git.branchSwitch', entryId: entryOf(sessionKey), branch });
}

export async function pushBranch(sessionKey: string): Promise<void> {
  await sendCommand(sessionKey, { name: 'git.push', entryId: entryOf(sessionKey) });
}

// ---- review commands (the comments arrive through the ops review.upsert/review.remove) ----

export type NewReviewComment = Pick<ReviewComment, 'path' | 'side' | 'line' | 'endLine' | 'quote' | 'text'>;

export async function addReviewComment(
  sessionKey: string,
  comment: NewReviewComment,
): Promise<ReviewComment> {
  const result = await sendCommand(sessionKey, {
    name: 'review.add',
    entryId: entryOf(sessionKey),
    ...comment,
  });
  return result.comment;
}

export interface ReviewCommentChange {
  text?: string;
  line?: number;
  endLine?: number;
  quote?: string;
  state?: 'open' | 'stale';
}

export async function updateReviewComment(
  sessionKey: string,
  commentId: ReviewComment['id'],
  change: ReviewCommentChange,
): Promise<void> {
  await sendCommand(sessionKey, {
    name: 'review.update',
    entryId: entryOf(sessionKey),
    commentId,
    ...change,
  });
}

export async function removeReviewComments(
  sessionKey: string,
  commentIds: readonly ReviewComment['id'][],
): Promise<void> {
  if (commentIds.length === 0) return;
  await sendCommand(sessionKey, {
    name: 'review.remove',
    entryId: entryOf(sessionKey),
    commentIds: [...commentIds],
  });
}

export async function markReviewSent(
  sessionKey: string,
  commentIds: readonly ReviewComment['id'][],
): Promise<void> {
  if (commentIds.length === 0) return;
  await sendCommand(sessionKey, {
    name: 'review.markSent',
    entryId: entryOf(sessionKey),
    commentIds: [...commentIds],
  });
}

// ---- loading ----

export interface ChangesData {
  /** null before the first answer. */
  status: GitStatus | null;
  /** null before the first answer (and while the folder is no repository). */
  diff: GitDiffList | null;
  /** The last load failed (the data of the load before stays). */
  error: ErrorPayload | null;
  /** A load runs (the data of the one before stays visible). */
  loading: boolean;
  /** Counts finished loads: an open file diff loads its patch again when it changes. */
  generation: number;
}

export interface ChangesHandle extends ChangesData {
  refresh: () => void;
}

interface Loaded extends Omit<ChangesData, 'loading'> {
  /** The request this answers (`loading` = a newer one runs). */
  key: string | null;
}

const INITIAL: Loaded = { status: null, diff: null, error: null, generation: 0, key: null };

export function useChangesData(
  sessionKey: string,
  scope: GitDiffScope,
  onlySessionFiles: boolean,
): ChangesHandle {
  const [data, setData] = useState<Loaded>(INITIAL);
  const [manual, setManual] = useState(0);
  const turnEnd = useSummarySelector(sessionKey, (summary) => summary.status.lastTurn?.endedAt ?? null, null);
  const branch = useSummarySelector(sessionKey, (summary) => summary.gitBranch, null);
  // Every reason to load again is part of the key: the tab opened (mount), the scope or filter
  // changed, a turn ended, HEAD moved (branch), "Refresh" or an action of the panel (`manual`).
  const key = [sessionKey, scope, String(onlySessionFiles), turnEnd ?? '', branch ?? '', String(manual)].join(
    '|',
  );

  useEffect(() => {
    let current = true;
    void Promise.allSettled([
      fetchGitStatus(sessionKey),
      fetchGitDiff(sessionKey, scope, onlySessionFiles),
    ]).then(([status, diff]) => {
      if (!current) return;
      setData((previous): Loaded => {
        if (status.status === 'rejected') return { ...previous, error: errorPayloadOf(status.reason), key };
        if (!status.value.isRepo) {
          return { status: status.value, diff: null, error: null, generation: previous.generation + 1, key };
        }
        if (diff.status === 'rejected') {
          return { ...previous, status: status.value, error: errorPayloadOf(diff.reason), key };
        }
        return {
          status: status.value,
          diff: diff.value,
          error: null,
          generation: previous.generation + 1,
          key,
        };
      });
    });
    return () => {
      current = false;
    };
  }, [key, sessionKey, scope, onlySessionFiles]);

  const refresh = useCallback(() => {
    setManual((count) => count + 1);
  }, []);
  const { key: answered, ...rest } = data;
  return { ...rest, loading: answered !== key, refresh };
}

export interface FileDiffState {
  file: GitDiffFile | null;
  /** When `file` arrived (window clock, ms); null before. Identifies one loaded patch. */
  at: number | null;
  error: ErrorPayload | null;
  loading: boolean;
}

/**
 * The patch of one file, loaded when its diff opens and again for every new `generation`; the patch
 * before stays visible while the next one loads.
 */
export function useFileDiff(
  sessionKey: string,
  scope: GitDiffScope,
  path: string,
  generation: number,
  enabled: boolean,
): FileDiffState & { retry: () => void } {
  const [state, setState] = useState<Omit<FileDiffState, 'loading'> & { key: string | null }>({
    file: null,
    at: null,
    error: null,
    key: null,
  });
  const [attempt, setAttempt] = useState(0);
  const key = [sessionKey, scope, path, String(generation), String(attempt)].join('|');
  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    fetchFileDiff(sessionKey, scope, path).then(
      (file) => {
        if (current) setState({ file, at: Date.now(), error: null, key });
      },
      (error: unknown) => {
        if (current) setState((previous) => ({ ...previous, error: errorPayloadOf(error), key }));
      },
    );
    return () => {
      current = false;
    };
  }, [key, sessionKey, scope, path, enabled]);
  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);
  return { file: state.file, at: state.at, error: state.error, loading: enabled && state.key !== key, retry };
}
