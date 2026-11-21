import { LOCAL_HOST_ID, makeSessionKey, type EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import type { GitDiffFile, GitStatus, HostState, ReviewComment, SessionSummary } from '@shared/model';
import type { Command } from '@shared/protocol';
import {
  SAMPLE_IDS,
  sampleDetail,
  sampleGitDiffFile,
  sampleGitFileChange,
  sampleGitStatus,
  sampleHostState,
  sampleId,
  sampleSessionSnapshot,
  sampleSha,
  sampleSummary,
} from '@shared/samples';
import {
  createHostConnection,
  registerConnection,
  unregisterConnection,
  type ManagedHostConnection,
} from '@web/state/connection';
import { FakeHost, type FakeAck } from '@web/state/fake-host';
import { createMemoryTransport } from '@web/state/transport';

/**
 * Test helpers of the tab "Changes" (WP-113; tests only, never imported by the app): a FakeHost behind
 * a real HostConnection on host `local` with a small fake git service (`git.*` from the `git` state)
 * and review store (`review.*` → the ops `review.upsert`/`review.remove`, like WP-111). Ops apply at
 * once (no animation frame). Tests call `stop()` and reset the stores in `afterEach`.
 */

export const CHANGES_SESSION_KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
export const CHANGES_ROOT = 'D:\\work\\sample';

/** A diff file with a 3-line context patch around line 10 of `src/login.ts` (new lines 10…14). */
export const SAMPLE_PATCH = sampleGitDiffFile().patch ?? '';

export interface FakeGitState {
  status: GitStatus;
  /** Files with their patches (the list answer leaves the patches out). */
  files: GitDiffFile[];
  base: string | null;
  truncated: boolean;
  /** `git.diff {onlySessionFiles: true}` keeps only these paths; null = all. */
  sessionPaths: string[] | null;
}

export interface ChangesHost {
  host: FakeHost;
  connection: ManagedHostConnection;
  git: FakeGitState;
  /** Commands of the given name the host received (in order). */
  commands<N extends Command['name']>(name: N): Extract<Command, { name: N }>[];
  /** The comments of the server view. */
  review(): readonly ReviewComment[];
  stop(): void;
}

export function changesHostState(p: Partial<HostState> = {}): HostState {
  return sampleHostState({ features: { git: true, search: false, overview: false }, ...p });
}

function reviewCommand(cmd: Command, host: FakeHost, nextId: () => ReviewComment['id']): FakeAck | undefined {
  if (
    cmd.name !== 'review.add' &&
    cmd.name !== 'review.update' &&
    cmd.name !== 'review.remove' &&
    cmd.name !== 'review.markSent'
  ) {
    return undefined;
  }
  const entryId: EntryId = cmd.entryId;
  const view = host.view(entryId);
  if (view === null) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
  const current = view.detail.review;
  switch (cmd.name) {
    case 'review.add': {
      const comment: ReviewComment = {
        id: nextId(),
        path: cmd.path,
        side: cmd.side,
        line: cmd.line,
        endLine: cmd.endLine,
        quote: cmd.quote,
        text: cmd.text,
        state: 'open',
        createdAt: host.now(),
        sentAt: null,
      };
      host.pushOps(entryId, [{ op: 'review.upsert', comments: [comment] }]);
      return { ok: true, result: { comment } };
    }
    case 'review.update': {
      const found = current.find((comment) => comment.id === cmd.commentId);
      if (found === undefined)
        return { ok: false, error: makeError('VALIDATION_FAILED', { field: 'commentId' }) };
      const comment: ReviewComment = {
        ...found,
        ...(cmd.text === undefined ? {} : { text: cmd.text }),
        ...(cmd.line === undefined ? {} : { line: cmd.line }),
        ...(cmd.endLine === undefined ? {} : { endLine: cmd.endLine }),
        ...(cmd.quote === undefined ? {} : { quote: cmd.quote }),
        ...(cmd.state === undefined ? {} : { state: cmd.state }),
      };
      host.pushOps(entryId, [{ op: 'review.upsert', comments: [comment] }]);
      return { ok: true, result: { comment } };
    }
    case 'review.remove':
      host.pushOps(entryId, [{ op: 'review.remove', commentIds: cmd.commentIds }]);
      return { ok: true, result: {} };
    case 'review.markSent': {
      const ids = new Set(cmd.commentIds);
      const sent = current
        .filter((comment) => ids.has(comment.id))
        .map((comment): ReviewComment => ({ ...comment, state: 'sent', sentAt: host.now() }));
      if (sent.length > 0) host.pushOps(entryId, [{ op: 'review.upsert', comments: sent }]);
      return { ok: true, result: {} };
    }
  }
}

function gitCommand(cmd: Command, git: FakeGitState): FakeAck | undefined {
  switch (cmd.name) {
    case 'git.status':
      return { ok: true, result: { status: git.status } };
    case 'git.diff': {
      const keep = cmd.onlySessionFiles && git.sessionPaths !== null ? new Set(git.sessionPaths) : null;
      return {
        ok: true,
        result: {
          root: git.status.root ?? CHANGES_ROOT,
          base: cmd.scope === 'session' ? git.base : null,
          files: git.files
            .filter((file) => keep === null || keep.has(file.path))
            .map((file) => ({ ...file, patch: null })),
          truncated: git.truncated,
        },
      };
    }
    case 'git.fileDiff': {
      const file = git.files.find((entry) => entry.path === cmd.path);
      return file === undefined
        ? { ok: false, error: makeError('GIT_FAILED', { op: 'diff' }) }
        : { ok: true, result: { file } };
    }
    case 'git.commit':
      return { ok: true, result: { sha: sampleSha(9) } };
    case 'git.branchCreate':
    case 'git.branchSwitch':
    case 'git.push':
      return { ok: true, result: {} };
    default:
      return undefined;
  }
}

export function startChangesHost(
  options: {
    git?: Partial<FakeGitState>;
    hostState?: Partial<HostState>;
    summary?: Partial<SessionSummary>;
    review?: ReviewComment[];
    onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined;
  } = {},
): ChangesHost {
  unregisterConnection(LOCAL_HOST_ID);
  const transport = createMemoryTransport();
  const git: FakeGitState = {
    status: sampleGitStatus({ root: CHANGES_ROOT, files: [sampleGitFileChange()] }),
    files: [sampleGitDiffFile()],
    base: sampleSha(1),
    truncated: false,
    sessionPaths: null,
    ...options.git,
  };
  let next = 100;
  const nextId = () => sampleId('rc', next++);
  const host = new FakeHost({
    transport,
    serverInstanceId: crypto.randomUUID(),
    hostState: changesHostState(options.hostState),
    summaries: [sampleSummary({ cwd: CHANGES_ROOT, ...options.summary })],
    sessions: [sampleSessionSnapshot({ detail: sampleDetail({ review: options.review ?? [] }) })],
    onCommand: (cmd, fake) =>
      options.onCommand?.(cmd, fake) ?? gitCommand(cmd, git) ?? reviewCommand(cmd, fake, nextId),
  });
  let reloadAt: number | null = null;
  const connection = createHostConnection({
    hostId: LOCAL_HOST_ID,
    createTransport: () => transport,
    reload: () => undefined,
    reloadGuard: {
      read: () => reloadAt,
      write: (at) => {
        reloadAt = at;
      },
    },
    scheduleFrame: (callback: () => void) => {
      callback();
    },
  });
  registerConnection(connection);
  connection.start();
  return {
    host,
    connection,
    git,
    commands: <N extends Command['name']>(name: N) =>
      host.commands.filter((cmd): cmd is Extract<Command, { name: N }> => cmd.name === name),
    review: () => host.view(SAMPLE_IDS.entry)?.detail.review ?? [],
    stop() {
      unregisterConnection(LOCAL_HOST_ID);
      host.dispose();
    },
  };
}

/** A patch of `count` added lines (a new file) – virtualized from 300 rows on. */
export function longPatch(count: number): string {
  const lines = Array.from({ length: count }, (_, index) => `+line ${String(index + 1)}`);
  return `@@ -0,0 +1,${String(count)} @@\n${lines.join('\n')}\n`;
}
