import { LIMITS, type EntryId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  DEFAULT_REMOTE_CONTROL_SUMMARY,
  isDefaultProgramAllowed,
  type AssistantTextItem,
  type Decision,
  type DecisionOutcome,
  type DecisionResponse,
  type FileInfo,
  type FileKind,
  type FileStatResult,
  type HostState,
  type PlanVersionInfo,
  type SessionFile,
  type SessionFileOp,
  type SessionSummary,
  type SideQuestionItem,
  type TaskInfo,
  type ToolCallItem,
  type ToolCallStatus,
  type TranscriptItem,
} from '@shared/model';
import { isWindowsPathInside, windowsPathIssue, windowsPathKey } from '@shared/paths';
import type {
  ClientHelloMessage,
  ClientMessage,
  Command,
  CommandName,
  CommandOf,
  PresenceState,
  SeqOp,
  ServerMessage,
  SessionOp,
  SessionSnapshot,
} from '@shared/protocol';
import {
  SAMPLE_IDS,
  sampleContextBreakdown,
  sampleDetail,
  sampleFileInfo,
  sampleHello,
  sampleHostState,
  sampleId,
  sampleItems,
  sampleModelOption,
  samplePlanVersionInfo,
  sampleSummary,
  sampleSystemItems,
  sampleTime,
} from '@shared/samples';
import { applySessionOp, trimItems, viewStateFromSnapshot, type SessionViewState } from '@shared/sync';
import { pathTail } from '@web/lib/path-display';
import { SHOWCASE_FILES } from '@web/playground/showcase/files';
import { FakeSessionInfoData } from './fake-session-info';
import type { MemoryTransport } from './transport';

/**
 * In-memory stand-in for a Parallax server behind a MemoryTransport (playground, tests of the
 * shell and of WP-15/16 components). It speaks the real protocol: hello → clientHello →
 * host.state → summaries.snapshot, subscribe → snapshot/replay, seq per entry, ring buffer, acks.
 * Server views are materialized with the same shared reducer as the client (@shared/sync).
 * Dev/test only – never imported by production code.
 */

export type FakeAck = { ok: true; result: unknown } | { ok: false; error: ErrorPayload };

export interface FakeHostOptions {
  transport: MemoryTransport;
  /** Default: SAMPLE_IDS.serverInstanceId. */
  serverInstanceId?: string;
  /** Default 'dev' (= BUILD_ID of unbundled runs). */
  buildId?: string;
  hostState?: HostState;
  summaries?: readonly SessionSummary[];
  /** Initial server-side views (one snapshot per entry). */
  sessions?: readonly SessionSnapshot[];
  /** Timestamps of new ops/items (default: the real time). */
  now?: () => string;
  /** Own command handling; return undefined to use the default behaviour. */
  onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined;
  /** Answer `session.sendPrompt` with a short streamed assistant reply (playground). */
  replyToPrompts?: boolean;
}

interface ServerSession {
  view: SessionViewState;
  buffer: SeqOp[];
}

const RING_BUFFER = LIMITS.ringBufferOps;

// ---- files (Phase 3, WP-54): a small file table for file.*, files.*, plan.* ----

/** Root of the fake project (= cwd of `sampleSummary`/`sampleEntry`). */
export const FAKE_FILE_ROOT = 'D:\\work\\sample';

/** One file of the fake host: metadata for file.stat and the text a FileSource may serve. */
export interface FakeFile {
  info: FileInfo;
  /** Text of a text/Markdown file (lazy: the big log is built on first use); null for other kinds. */
  text: (() => string) | null;
}

/** Paths of the fake table (tests, playground). */
export const FAKE_FILE_PATHS = {
  readme: 'D:\\work\\sample\\README.md',
  guide: 'D:\\work\\sample\\docs\\guide.md',
  main: 'D:\\work\\sample\\src\\main.ts',
  packageJson: 'D:\\work\\sample\\package.json',
  log: 'D:\\work\\sample\\logs\\build.log',
  image: 'D:\\work\\sample\\assets\\diagram.png',
  pdf: 'D:\\work\\sample\\docs\\spec.pdf',
  binary: 'D:\\work\\sample\\bin\\tool.dat',
  folder: 'D:\\work\\sample\\src',
  /** Below the root but not in the table: FILE_NOT_FOUND. */
  missing: 'D:\\work\\sample\\missing.md',
  /** Outside every root: PATH_NOT_ALLOWED. */
  outside: 'D:\\private\\secret.txt',
  /** Listed in the session file index (access 'session'). */
  plan: 'C:\\Users\\user\\.claude\\plans\\sample.md',
  taskOutput: 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\tasks\\task_01.output',
} as const;

const README_TEXT = [
  '# Sample project',
  '',
  'A small project for the Parallax playground. Start with the [guide](docs/guide.md); the entry',
  'point is `src/main.ts`.',
  '',
  '## Build',
  '',
  '```powershell',
  'pnpm install',
  'pnpm build',
  '```',
  '',
  '- [x] Read the code',
  '- [ ] Write the tests',
  '',
  '| File | Purpose |',
  '| --- | --- |',
  '| `src/main.ts` | Entry point |',
  '| `logs/build.log` | Output of the last build |',
  '',
].join('\n');

const GUIDE_TEXT = [
  '# Guide',
  '',
  'Back to the [README](../README.md).',
  '',
  '1. Open `src/main.ts`.',
  '2. Change the greeting.',
  '3. Run `pnpm build` and read `logs/build.log`.',
  '',
  '> The viewer reloads by itself when a file changes on disk.',
  '',
].join('\n');

const MAIN_TEXT = [
  "import { readFile } from 'node:fs/promises';",
  "import { join } from 'node:path';",
  '',
  '/** Settings of the sample tool. */',
  'interface Options {',
  '  name: string;',
  '  verbose: boolean;',
  '  retries: number;',
  '}',
  '',
  "const DEFAULTS: Options = { name: 'world', verbose: false, retries: 3 };",
  '',
  'export function greet(options: Partial<Options> = {}): string {',
  '  const { name, verbose } = { ...DEFAULTS, ...options };',
  '  const text = `Hello, ${name}!`;',
  '  return verbose ? `${text} (verbose)` : text;',
  '}',
  '',
  'export async function loadOptions(folder: string): Promise<Options> {',
  "  const raw = await readFile(join(folder, 'options.json'), 'utf8');",
  '  const parsed: unknown = JSON.parse(raw);',
  "  if (typeof parsed !== 'object' || parsed === null) return DEFAULTS;",
  '  return { ...DEFAULTS, ...(parsed as Partial<Options>) };',
  '}',
  '',
  'async function main(): Promise<void> {',
  '  const options = await loadOptions(process.cwd());',
  '  for (let attempt = 1; attempt <= options.retries; attempt++) {',
  '    console.log(`${String(attempt)}: ${greet(options)}`);',
  '  }',
  '}',
  '',
  'void main();',
  '',
].join('\n');

const PACKAGE_TEXT = [
  '{',
  '  "name": "sample",',
  '  "version": "1.0.0",',
  '  "type": "module",',
  '  "scripts": { "build": "tsc -b", "test": "vitest run" }',
  '}',
  '',
].join('\n');

const TASK_OUTPUT_TEXT = [
  '> pnpm test',
  '',
  ' ✓ src/main.test.ts (3 tests) 12ms',
  '',
  ' Test Files  1 passed (1)',
  '',
].join('\n');

/** Lines of the big log (plain text in the viewer: far above the highlighting limit). */
export const FAKE_LOG_LINES = 6000;

let logText: string | null = null;
function bigLog(): string {
  logText ??= Array.from({ length: FAKE_LOG_LINES }, (_, index) => {
    const n = index + 1;
    const level = n % 97 === 0 ? 'warn ' : 'info ';
    return `[12:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.${String(n % 1000).padStart(3, '0')}] ${level} step ${String(n)} of ${String(FAKE_LOG_LINES)}: compiled module-${String(n).padStart(4, '0')}.ts in ${String((n * 7) % 90)} ms`;
  }).join('\n');
  return logText;
}

/** Plan texts of the two stored versions (plan.read). */
export const FAKE_PLAN_TEXTS = [
  ['# Plan', '', '1. Read `src/main.ts`', '2. Add tests'].join('\n'),
  ['# Plan', '', '1. Read `src/main.ts`', '2. Add tests', '3. Run `pnpm check`'].join('\n'),
] as const;

function fakeInfo(path: string, kind: FileKind, p: Partial<FileInfo> = {}): FileInfo {
  const media: Readonly<Record<FileKind, string | null>> = {
    text: 'text/plain; charset=utf-8',
    markdown: 'text/plain; charset=utf-8',
    image: 'image/png',
    pdf: 'application/pdf',
    binary: null,
    directory: null,
  };
  const textual = kind === 'text' || kind === 'markdown';
  return sampleFileInfo({
    path,
    realPath: path,
    kind,
    mediaType: media[kind],
    encoding: textual ? 'utf-8' : null,
    previewable: kind !== 'binary' && kind !== 'directory',
    ...p,
  });
}

function textFile(
  path: string,
  kind: 'text' | 'markdown',
  text: () => string,
  p: Partial<FileInfo> = {},
): FakeFile {
  return { info: fakeInfo(path, kind, { bytes: new TextEncoder().encode(text()).length, ...p }), text };
}

/**
 * A fresh copy of the table (each FakeHost may change its own files). WP-68: plus the files of the
 * README showcase projects (`D:\dev\…`) – the playground's static FileSource reads this table once
 * at module load, so they must be in it from the start.
 */
export function fakeFileTable(): FakeFile[] {
  return [
    textFile(FAKE_FILE_PATHS.readme, 'markdown', () => README_TEXT),
    textFile(FAKE_FILE_PATHS.guide, 'markdown', () => GUIDE_TEXT),
    textFile(FAKE_FILE_PATHS.main, 'text', () => MAIN_TEXT),
    textFile(FAKE_FILE_PATHS.packageJson, 'text', () => PACKAGE_TEXT),
    // The server cuts texts above LIMITS.fileTextBytes at a line end (ADR-142).
    { info: fakeInfo(FAKE_FILE_PATHS.log, 'text', { bytes: 3_250_000, truncated: true }), text: bigLog },
    { info: fakeInfo(FAKE_FILE_PATHS.image, 'image', { bytes: 24_576 }), text: null },
    { info: fakeInfo(FAKE_FILE_PATHS.pdf, 'pdf', { bytes: 182_044 }), text: null },
    { info: fakeInfo(FAKE_FILE_PATHS.binary, 'binary', { bytes: 65_536 }), text: null },
    { info: fakeInfo(FAKE_FILE_PATHS.folder, 'directory', { bytes: 0 }), text: null },
    textFile(FAKE_FILE_PATHS.plan, 'markdown', () => FAKE_PLAN_TEXTS[1], { access: 'session' }),
    textFile(FAKE_FILE_PATHS.taskOutput, 'text', () => TASK_OUTPUT_TEXT, { access: 'session' }),
    ...SHOWCASE_FILES.map((file) =>
      textFile(file.path, file.kind, () => file.text, { mtimeMs: file.mtimeMs }),
    ),
  ];
}

/** The session file index of every known entry at start (newest `lastAt` first). */
export function fakeSessionFiles(): SessionFile[] {
  const file = (path: string, ops: SessionFileOp[], seconds: number, count = 1): SessionFile => ({
    path,
    ops,
    count,
    firstAt: sampleTime(4),
    lastAt: sampleTime(seconds),
    lastToolUseId: ops.includes('attached') ? null : SAMPLE_IDS.toolUseId,
    conversationId: SAMPLE_IDS.conversation,
  });
  return [
    file(FAKE_FILE_PATHS.main, ['read', 'edited'], 40, 3),
    file(FAKE_FILE_PATHS.plan, ['plan'], 35),
    file(FAKE_FILE_PATHS.readme, ['read'], 30),
    file(FAKE_FILE_PATHS.taskOutput, ['output'], 28),
    file(FAKE_FILE_PATHS.log, ['read'], 20),
    file(FAKE_FILE_PATHS.image, ['attached'], 10),
    file(FAKE_FILE_PATHS.guide, ['written'], 8),
  ];
}

/** Input key of the file path per file tool (like the normalizer's tool inputs). */
const FILE_TOOL_KEYS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

function opOfTool(toolName: string): SessionFileOp {
  if (toolName === 'Read') return 'read';
  return toolName === 'Write' ? 'written' : 'edited';
}

export interface FakeFileToolCall {
  /** Default 'Edit'. */
  toolName?: 'Read' | 'Write' | 'Edit' | 'MultiEdit' | 'NotebookEdit';
  path: string;
  /** Default 'done' (a finished call triggers the viewer reload and the files panel refresh). */
  status?: ToolCallStatus;
  isError?: boolean;
}

/** Status of the gated tool call after the answer (playground approximation of the engine). */
function toolStatusAfter(outcome: DecisionOutcome): ToolCallStatus {
  switch (outcome.type) {
    case 'allowed':
      return 'running';
    case 'answered':
    case 'plan_approved':
      return 'done';
    default:
      return 'denied';
  }
}

function outcomeFor(response: DecisionResponse): DecisionOutcome {
  switch (response.kind) {
    case 'permission':
      return response.response.behavior === 'allow'
        ? {
            type: 'allowed',
            remember: response.response.remember,
            acceptEdits: response.response.acceptEdits,
          }
        : {
            type: 'denied',
            withMessage: response.response.message !== '',
            interrupt: response.response.interrupt,
          };
    case 'question':
      return response.response.behavior === 'answer' ? { type: 'answered' } : { type: 'declined' };
    case 'plan':
      if (response.response.behavior === 'revise') return { type: 'plan_revised' };
      return {
        type: 'plan_approved',
        mode: response.response.mode,
        edited: response.response.editedPlan !== null,
        freshContext: response.response.behavior === 'approve_fresh_context',
      };
  }
}

export class FakeHost {
  readonly transport: MemoryTransport;
  serverInstanceId: string;
  buildId: string;
  hostState: HostState;
  readonly summaries = new Map<EntryId, SessionSummary>();
  readonly sessions = new Map<EntryId, ServerSession>();
  readonly subscribed = new Set<EntryId>();
  clientHello: ClientHelloMessage | null = null;
  presence: PresenceState | null = null;
  /** Every command received (assertions in tests). */
  readonly commands: Command[] = [];
  /** When false, connections are dropped right away (offline simulation). */
  online = true;

  private readonly options: FakeHostOptions;
  private readonly cleanups: (() => void)[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Running `streamAssistantText` calls per entry: abort functions (session.interrupt). */
  private readonly streams = new Map<EntryId, Set<() => void>>();
  private handshaken = false;
  private nextEntry = 100;

  // Phase 3 (WP-54): files, plan versions
  /** File table (key: windowsPathKey): file.stat/statMany/open, files.project, a playground FileSource. */
  readonly files = new Map<string, FakeFile>();
  /** Every file.open that passed the checks – also the ones `fileOpenError` fails (assertions). */
  readonly fileOpens: CommandOf<'file.open'>[] = [];
  /** When set, file.open fails with this error after the checks (e.g. EDITOR_NOT_FOUND). */
  fileOpenError: ErrorPayload | null = null;
  /** WP-65: every link.open (assertions); `linkOpenError` fails them (the web then opens the link itself). */
  readonly linkOpens: string[] = [];
  linkOpenError: ErrorPayload | null = null;
  /** Session file index per entry (files.session); a known entry without one starts with fakeSessionFiles(). */
  readonly sessionFiles = new Map<EntryId, SessionFile[]>();
  /** `truncated` of every files.session answer (more than LIMITS.sessionFilesMax on a real host). */
  sessionFilesTruncated = false;
  /** One-shot failures per command name (failNext). */
  private readonly failures = new Map<CommandName, ErrorPayload[]>();
  /** WP-67: session info answers and actions; levers `unavailable`, `actionError`, `long`. */
  readonly info = new FakeSessionInfoData();
  /** Stored plan versions, ascending (plan.list, plan.read; `stored: false` → PLAN_NOT_FOUND). */
  planVersions: { info: PlanVersionInfo; text: string }[] = [
    {
      info: samplePlanVersionInfo({
        version: 1,
        resolvedAt: sampleTime(4),
        outcome: { type: 'plan_revised' },
      }),
      text: FAKE_PLAN_TEXTS[0],
    },
    {
      info: samplePlanVersionInfo({ version: 2, decisionId: sampleId('dc', 4), createdAt: sampleTime(6) }),
      text: FAKE_PLAN_TEXTS[1],
    },
  ];

  constructor(options: FakeHostOptions) {
    this.options = options;
    this.transport = options.transport;
    this.serverInstanceId = options.serverInstanceId ?? SAMPLE_IDS.serverInstanceId;
    this.buildId = options.buildId ?? 'dev';
    this.hostState = options.hostState ?? sampleHostState();
    for (const summary of options.summaries ?? []) this.summaries.set(summary.entryId, summary);
    for (const snapshot of options.sessions ?? []) this.addSession(snapshot);
    for (const file of fakeFileTable()) this.setFile(file);
    this.cleanups.push(
      this.transport.onConnect(() => {
        this.handleConnect();
      }),
      this.transport.onClientMessage((message) => {
        this.handleClientMessage(message);
      }),
    );
  }

  // ---- state changes (broadcast like the real hub) ----

  now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  addSession(snapshot: SessionSnapshot): void {
    this.sessions.set(snapshot.entryId, { view: viewStateFromSnapshot(snapshot), buffer: [] });
  }

  view(entryId: EntryId): SessionViewState | null {
    return this.sessions.get(entryId)?.view ?? null;
  }

  upsertSummary(summary: SessionSummary): void {
    this.summaries.set(summary.entryId, summary);
    this.broadcast({ type: 'summary.upsert', summary });
  }

  /** Shallow patch of a summary (and its status facts). */
  patchSummary(
    entryId: EntryId,
    patch: Partial<SessionSummary>,
    status: Partial<SessionSummary['status']> = {},
  ): void {
    const current = this.summaries.get(entryId);
    if (current === undefined) return;
    this.upsertSummary({ ...current, ...patch, status: { ...current.status, ...patch.status, ...status } });
  }

  removeSummary(entryId: EntryId): void {
    this.summaries.delete(entryId);
    this.broadcast({ type: 'summary.remove', entryId });
  }

  setHostState(hostState: HostState): void {
    this.hostState = hostState;
    this.broadcast({ type: 'host.state', host: hostState });
  }

  /** Assigns seqs, applies the ops to the server view and sends them to a subscribed client. */
  pushOps(entryId: EntryId, ops: readonly SessionOp[]): SeqOp[] {
    const session = this.sessions.get(entryId);
    if (session === undefined || ops.length === 0) return [];
    const at = this.now();
    const seqOps: SeqOp[] = [];
    let view = session.view;
    for (const op of ops) {
      view = applySessionOp(view, op);
      const seqOp: SeqOp = { seq: view.seq + seqOps.length + 1, at, op };
      seqOps.push(seqOp);
    }
    const last = seqOps.at(-1);
    session.view = { ...view, seq: last?.seq ?? view.seq };
    session.buffer.push(...seqOps);
    if (session.buffer.length > RING_BUFFER) session.buffer.splice(0, session.buffer.length - RING_BUFFER);
    if (this.subscribed.has(entryId)) this.send({ type: 'session.ops', entryId, ops: seqOps });
    return seqOps;
  }

  /** Sends an op batch with a seq gap (tests of the client's gap handling). */
  sendRaw(message: ServerMessage): void {
    this.send(message);
  }

  /** Recounts the summary's open/expired decisions from the server view. */
  syncDecisionCounts(entryId: EntryId): void {
    const view = this.view(entryId);
    const summary = this.summaries.get(entryId);
    if (view === null || summary === undefined) return;
    const open = view.decisions.filter((d) => d.state === 'open');
    const countOf = (kind: Decision['kind']) => open.filter((d) => d.kind === kind).length;
    this.patchSummary(
      entryId,
      {},
      {
        decisions: {
          permission: countOf('permission'),
          question: countOf('question'),
          plan: countOf('plan'),
          oldestKind: open[0]?.kind ?? null,
          expired: view.decisions.filter((d) => d.state === 'expired').length,
        },
      },
    );
  }

  /**
   * Streams an assistant text: upsert (streaming) → one `item.delta` per chunk → final upsert.
   * Returns a cancel function (stops silently). `session.interrupt` aborts every running stream of
   * the entry: final upsert with the text so far and `aborted: true`, then `onDone`.
   */
  streamAssistantText(
    entryId: EntryId,
    options: {
      item: AssistantTextItem;
      text: string;
      chunkSize?: number;
      intervalMs?: number;
      onDone?: () => void;
    },
  ): () => void {
    const chunkSize = options.chunkSize ?? 6;
    const intervalMs = options.intervalMs ?? 40;
    const chunks: string[] = [];
    for (let i = 0; i < options.text.length; i += chunkSize)
      chunks.push(options.text.slice(i, i + chunkSize));
    this.pushOps(entryId, [{ op: 'item.upsert', item: { ...options.item, text: '', streaming: true } }]);
    let index = 0;
    let cancelled = false;
    let streamed = '';
    const active = this.streams.get(entryId) ?? new Set<() => void>();
    this.streams.set(entryId, active);
    const abort = () => {
      if (cancelled) return;
      cancelled = true;
      active.delete(abort);
      this.pushOps(entryId, [
        { op: 'item.upsert', item: { ...options.item, text: streamed, streaming: false, aborted: true } },
      ]);
      options.onDone?.();
    };
    active.add(abort);
    const step = () => {
      if (cancelled) return;
      const chunk = chunks[index];
      if (chunk === undefined) {
        cancelled = true;
        active.delete(abort);
        this.pushOps(entryId, [
          { op: 'item.upsert', item: { ...options.item, text: options.text, streaming: false } },
        ]);
        options.onDone?.();
        return;
      }
      index++;
      streamed += chunk;
      this.pushOps(entryId, [{ op: 'item.delta', itemId: options.item.id, field: 'text', append: chunk }]);
      this.later(step, intervalMs);
    };
    this.later(step, intervalMs);
    return () => {
      cancelled = true;
      active.delete(abort);
    };
  }

  /** Aborts the running streams of an entry (default answer to `session.interrupt`). */
  interruptStreams(entryId: EntryId): number {
    const active = [...(this.streams.get(entryId) ?? [])];
    for (const abort of active) abort();
    return active.length;
  }

  /** Runs `fn` after `ms` (cleared by dispose). */
  later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  /** Drops the connection (client reconnects); `newInstance` simulates a server restart. */
  restart(options: { newInstance?: boolean; code?: number } = {}): void {
    if (options.newInstance === true) {
      this.serverInstanceId = crypto.randomUUID();
      for (const session of this.sessions.values()) {
        session.view = { ...session.view, seq: 0 };
        session.buffer = [];
      }
    }
    this.handshaken = false;
    this.subscribed.clear();
    this.transport.serverClose(options.code ?? 1006);
  }

  /**
   * Test helper (WP-54): the next command `name` fails with `error` (once per call; queued), before
   * `onCommand` and the default answer – e.g. a failed files.session or file.stat.
   */
  failNext(name: CommandName, error: ErrorPayload): void {
    const queue = this.failures.get(name) ?? [];
    queue.push(error);
    this.failures.set(name, queue);
  }

  // ---- files (Phase 3, WP-54) ----

  file(path: string): FakeFile | undefined {
    return this.files.get(windowsPathKey(path));
  }

  /** Adds or replaces a file of the table. */
  setFile(file: FakeFile): void {
    this.files.set(windowsPathKey(file.info.path), file);
  }

  /** Text a FileSource serves for `path` (playground, tests); null for unknown and non-text files. */
  fileText(path: string): string | null {
    return this.file(path)?.text?.() ?? null;
  }

  /**
   * Changes a file "on disk": `mtimeMs` +1 s (or the given one), optionally a new text (`bytes`
   * follow). The next file.stat of a viewer sees the change. Null for an unknown path.
   */
  touchFile(path: string, change: { text?: string; mtimeMs?: number } = {}): FileInfo | null {
    const file = this.file(path);
    if (file === undefined) return null;
    const { text } = change;
    const info: FileInfo = {
      ...file.info,
      mtimeMs: change.mtimeMs ?? file.info.mtimeMs + 1000,
      bytes: text === undefined ? file.info.bytes : new TextEncoder().encode(text).length,
    };
    this.setFile({ info, text: text === undefined ? file.text : () => text });
    return info;
  }

  /**
   * One answer of file.stat/statMany like the file service (ADR-141): C.10 filter → table →
   * FILE_NOT_FOUND below the root (summary cwd, else FAKE_FILE_ROOT) → PATH_NOT_ALLOWED.
   */
  statFile(entryId: EntryId, path: string): FileStatResult {
    if (windowsPathIssue(path) !== null) return { path, ok: false, error: makeError('PATH_REJECTED') };
    const file = this.file(path);
    if (file !== undefined) return { path, ok: true, file: { ...file.info, path } };
    const root = this.summaries.get(entryId)?.cwd ?? FAKE_FILE_ROOT;
    const code = isWindowsPathInside(path, root) ? 'FILE_NOT_FOUND' : 'PATH_NOT_ALLOWED';
    return { path, ok: false, error: makeError(code) };
  }

  /** The session file index of an entry (created from fakeSessionFiles() on first use). */
  sessionFilesOf(entryId: EntryId): SessionFile[] {
    let files = this.sessionFiles.get(entryId);
    if (files === undefined) {
      files = fakeSessionFiles();
      this.sessionFiles.set(entryId, files);
    }
    return files;
  }

  /**
   * Test helper: a file tool call (Read/Write/Edit/MultiEdit/NotebookEdit) on `path` lands in the
   * transcript – finished by default, so the viewer reloads and "Files of this session" refreshes.
   * A finished write also touches the file (new mtime) and every finished call updates the index.
   */
  emitFileToolCall(entryId: EntryId, call: FakeFileToolCall): ToolCallItem {
    const toolName = call.toolName ?? 'Edit';
    const status = call.status ?? 'done';
    const isError = call.isError === true;
    const order = this.nextOrder(entryId);
    const at = this.now();
    const messageId = `msg_fake_file_${String(order)}`;
    const key = FILE_TOOL_KEYS[toolName] ?? 'file_path';
    const item = sampleItems.toolCall({
      id: `${messageId}:0`,
      order,
      at,
      messageId,
      blockIndex: 0,
      toolUseId: `toolu_fake_file_${String(order)}`,
      toolName,
      input:
        toolName === 'Edit'
          ? { [key]: call.path, old_string: 'old', new_string: 'new' }
          : { [key]: call.path },
      status,
      result:
        status === 'done'
          ? {
              isError,
              content: [{ type: 'text', text: { text: isError ? 'Error' : 'OK', truncated: null } }],
              structured: null,
              structuredTruncated: null,
              at,
            }
          : null,
    });
    if (status === 'done' && !isError) {
      if (toolName !== 'Read') this.touchFile(call.path);
      this.recordSessionFile(entryId, call.path, opOfTool(toolName), item.toolUseId, at);
    }
    this.pushOps(entryId, [{ op: 'item.upsert', item }]);
    return item;
  }

  private recordSessionFile(
    entryId: EntryId,
    path: string,
    op: SessionFileOp,
    toolUseId: string,
    at: string,
  ): void {
    const files = this.sessionFilesOf(entryId);
    const index = files.findIndex((file) => windowsPathKey(file.path) === windowsPathKey(path));
    const previous = files[index];
    const next: SessionFile =
      previous === undefined
        ? {
            path,
            ops: [op],
            count: 1,
            firstAt: at,
            lastAt: at,
            lastToolUseId: toolUseId,
            conversationId: this.view(entryId)?.conversationId ?? null,
          }
        : {
            ...previous,
            ops: previous.ops.includes(op) ? previous.ops : [...previous.ops, op],
            count: previous.count + 1,
            lastAt: at,
            lastToolUseId: toolUseId,
          };
    this.sessionFiles.set(entryId, [next, ...files.filter((_, position) => position !== index)]);
  }

  /**
   * session.stopTask like the engine (ADR-149): the task of the tool call is reported `stopped`
   * (task_notification), a background task leaves `detail.backgroundTasks`.
   */
  /**
   * WP-65: like the CLI's backgroundTasks – the given running main-thread Bash/Agent call (or every
   * one) gets status `background`; TASK_NOT_FOUND when none matches.
   */
  private backgroundTasks(entryId: EntryId, toolUseId: string | null): FakeAck {
    const view = this.view(entryId);
    if (view === null) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
    const running = view.items.filter(
      (item): item is ToolCallItem =>
        item.kind === 'tool_call' &&
        item.parentToolUseId === null &&
        item.status === 'running' &&
        (toolUseId === null || item.toolUseId === toolUseId),
    );
    if (running.length === 0) {
      if (toolUseId === null) return this.ok();
      return { ok: false, error: makeError('TASK_NOT_FOUND', { taskId: toolUseId }) };
    }
    this.pushOps(
      entryId,
      running.map((item): SessionOp => ({ op: 'item.upsert', item: { ...item, status: 'background' } })),
    );
    return this.ok();
  }

  private stopTask(entryId: EntryId, taskId: string): FakeAck {
    const view = this.view(entryId);
    if (view === null) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
    const owner = view.items.find(
      (item): item is ToolCallItem =>
        item.kind === 'tool_call' && item.task?.taskId === taskId && item.task.endedAt === null,
    );
    const background = view.detail.backgroundTasks.find((task) => task.taskId === taskId);
    if (owner === undefined && background === undefined) {
      return { ok: false, error: makeError('TASK_NOT_FOUND', { taskId }) };
    }
    const at = this.now();
    const task: TaskInfo = {
      taskId,
      taskType: background?.taskType ?? null,
      description: background?.description ?? '',
      subagentType: background?.subagentType ?? null,
      isBackgrounded: true,
      summary: null,
      usage: null,
      startedAt: null,
      outputFile: null,
      ...owner?.task,
      status: 'stopped',
      endedAt: at,
    };
    const ops: SessionOp[] = [];
    if (owner !== undefined) ops.push({ op: 'item.upsert', item: { ...owner, task } });
    ops.push({
      op: 'item.upsert',
      item: sampleSystemItems.task_notification({
        id: crypto.randomUUID(),
        order: this.nextOrder(entryId),
        at,
        task,
      }),
    });
    if (background !== undefined) {
      ops.push({
        op: 'detail.patch',
        patch: { backgroundTasks: view.detail.backgroundTasks.filter((entry) => entry.taskId !== taskId) },
      });
    }
    this.pushOps(entryId, ops);
    return this.ok();
  }

  private knowsEntry(entryId: EntryId): boolean {
    return this.sessions.has(entryId) || this.summaries.has(entryId);
  }

  /** WP-67: the engine's gates of session.info/mcpAction/reload (no auto-wake). */
  private infoGate(entryId: EntryId): ErrorPayload | null {
    const summary = this.summaries.get(entryId);
    if (summary === undefined) return makeError(this.knowsEntry(entryId) ? 'SESSION_NOT_RUNNING' : 'ENTRY_NOT_FOUND', { entryId });
    if (summary.archived) return makeError('SESSION_ARCHIVED', { entryId });
    const runState = summary.status.runState;
    if (runState === 'external') return makeError('SESSION_EXTERNAL', { entryId });
    if (runState === 'sleeping' || runState === 'error') return makeError('SESSION_NOT_RUNNING', { entryId });
    return null;
  }

  dispose(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  // ---- protocol ----

  private send(message: ServerMessage): void {
    if (this.transport.connected) this.transport.serverSend(message);
  }

  private broadcast(message: ServerMessage): void {
    if (this.handshaken) this.send(message);
  }

  private handleConnect(): void {
    this.handshaken = false;
    this.subscribed.clear();
    if (!this.online) {
      this.transport.serverClose(1006);
      return;
    }
    this.send(
      sampleHello({
        serverInstanceId: this.serverInstanceId,
        buildId: this.buildId,
        serverStartedAt: sampleTime(),
      }),
    );
  }

  private handleClientMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'clientHello':
        this.clientHello = message;
        this.presence = message.presence;
        this.handshaken = true;
        this.send({ type: 'host.state', host: this.hostState });
        this.send({ type: 'summaries.snapshot', summaries: [...this.summaries.values()] });
        return;
      case 'presence':
        this.presence = message.presence;
        return;
      case 'subscribe':
        this.handleSubscribe(message.entryId, message.sinceSeq);
        return;
      case 'unsubscribe':
        this.subscribed.delete(message.entryId);
        return;
      case 'cmd': {
        this.commands.push(message.cmd);
        const failure = this.failures.get(message.cmd.name)?.shift();
        const ack: FakeAck =
          failure === undefined
            ? (this.options.onCommand?.(message.cmd, this) ?? this.defaultCommand(message.cmd))
            : { ok: false, error: failure };
        this.send(
          ack.ok
            ? { type: 'ack', cmdId: message.cmdId, ok: true, result: ack.result }
            : { type: 'ack', cmdId: message.cmdId, ok: false, error: ack.error },
        );
        if (message.cmd.name === 'server.shutdown')
          this.later(() => {
            this.transport.serverClose(4503);
          }, 0);
        return;
      }
    }
  }

  private handleSubscribe(entryId: EntryId, sinceSeq: number | undefined): void {
    const session = this.sessions.get(entryId);
    if (session === undefined) {
      this.send({ type: 'session.unavailable', entryId, error: makeError('ENTRY_NOT_FOUND') });
      return;
    }
    this.subscribed.add(entryId);
    const first = session.buffer[0];
    const replayable =
      sinceSeq !== undefined &&
      sinceSeq <= session.view.seq &&
      (sinceSeq === session.view.seq || (first !== undefined && first.seq <= sinceSeq + 1));
    if (replayable) {
      this.send({ type: 'session.ops', entryId, ops: session.buffer.filter((op) => op.seq > sinceSeq) });
      return;
    }
    const trimmed = trimItems(session.view, LIMITS.snapshotItems);
    this.send({
      type: 'session.snapshot',
      entryId,
      seq: session.view.seq,
      items: trimmed.items,
      hasEarlier: trimmed.hasEarlier,
      decisions: session.view.decisions,
      detail: session.view.detail,
    });
  }

  private nextOrder(entryId: EntryId): number {
    const items = this.view(entryId)?.items ?? [];
    return (items.at(-1)?.order ?? 0) + 1;
  }

  private ok(result: unknown = {}): FakeAck {
    return { ok: true, result };
  }

  private defaultCommand(cmd: Command): FakeAck {
    switch (cmd.name) {
      case 'settings.update': {
        const settings = { ...this.hostState.settings, ...cmd.patch };
        this.setHostState({ ...this.hostState, settings });
        return this.ok({ settings });
      }
      case 'decision.respond': {
        const decision = this.view(cmd.entryId)?.decisions.find((d) => d.id === cmd.decisionId);
        if (decision === undefined) return { ok: false, error: makeError('DECISION_ALREADY_RESOLVED') };
        if (decision.kind !== cmd.response.kind)
          return { ok: false, error: makeError('DECISION_OPTION_UNAVAILABLE') };
        const outcome = outcomeFor(cmd.response);
        // Like the engine: the outcome lands in the gating tool_call (architecture §2.3e – the
        // transcript shows the final state from tool_call.decision, the DecisionCard is gone).
        const toolCall = this.view(cmd.entryId)?.items.find(
          (item) =>
            item.kind === 'tool_call' &&
            (item.decision?.decisionId === decision.id || item.toolUseId === decision.toolUseId),
        );
        const toolCallOps: SessionOp[] =
          toolCall?.kind === 'tool_call'
            ? [
                {
                  op: 'item.upsert',
                  item: {
                    ...toolCall,
                    status: toolStatusAfter(outcome),
                    decision: {
                      decisionId: decision.id,
                      kind: decision.kind,
                      planVersion: decision.kind === 'plan' ? decision.version : null,
                      ...toolCall.decision,
                      outcome,
                    },
                  },
                },
              ]
            : [];
        this.pushOps(cmd.entryId, [
          {
            op: 'decision.resolved',
            decisionId: decision.id,
            outcome,
            byClientId: this.clientHello?.clientId ?? null,
            at: this.now(),
          },
          ...toolCallOps,
        ]);
        this.syncDecisionCounts(cmd.entryId);
        return this.ok({ outcome });
      }
      case 'session.sendPrompt':
        return this.ok({ messageUuid: this.acceptPrompt(cmd.entryId, cmd.prompt.text, cmd.priority) });
      case 'session.create': {
        const entryId = sampleId('en', this.nextEntry++);
        const conversationId = sampleId('cv', this.nextEntry);
        this.addSession({
          type: 'session.snapshot',
          entryId,
          seq: 0,
          items: [],
          hasEarlier: false,
          decisions: [],
          detail: sampleDetail({ entryId, conversationId, conversations: [], init: null }),
        });
        this.upsertSummary(
          sampleSummary({
            entryId,
            cwd: cmd.cwd,
            title: cmd.title ?? pathTail(cmd.cwd, 1),
            createdAt: this.now(),
            lastActivityAt: this.now(),
            sessionId: null,
            context: null,
            status: { ...sampleSummary().status, runState: 'sleeping' },
          }),
        );
        const messageUuid =
          cmd.prompt === undefined ? null : this.acceptPrompt(entryId, cmd.prompt.text, 'next');
        return this.ok({ entryId, messageUuid });
      }
      case 'session.interrupt':
        if (this.interruptStreams(cmd.entryId) > 0) {
          this.patchSummary(cmd.entryId, { lastActivityAt: this.now() }, { runState: 'idle' });
        }
        return this.ok({ stillQueued: [] });
      case 'session.rename':
        this.patchSummary(cmd.entryId, cmd.title === null ? {} : { title: cmd.title, titleSource: 'custom' });
        return this.ok();
      case 'session.setPermissionMode':
        this.patchSummary(cmd.entryId, { permissionMode: cmd.mode });
        return this.ok();
      case 'session.setModel':
        this.patchSummary(cmd.entryId, { modelSetting: cmd.model });
        return this.ok();
      case 'session.setPinned':
        this.patchSummary(cmd.entryId, { pinned: cmd.pinned });
        return this.ok();
      case 'session.setArchived':
        this.patchSummary(cmd.entryId, { archived: cmd.archived });
        return this.ok();
      // WP-64: Remote Control connects at once (fake claude.ai link per entry).
      case 'session.setRemoteControl':
        this.patchSummary(cmd.entryId, {
          remoteControl: cmd.enabled
            ? {
                state: 'connected',
                sessionUrl: `https://claude.ai/code/session_fakeweb${cmd.entryId.replace(/[^a-z0-9]/gi, '')}`,
                error: null,
                wanted: true,
              }
            : DEFAULT_REMOTE_CONTROL_SUMMARY,
        });
        return this.ok();
      case 'session.remove': {
        // WP-63: like the hub – summary.remove for all, session.unavailable for a subscriber.
        if (!this.knowsEntry(cmd.entryId)) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
        this.interruptStreams(cmd.entryId);
        this.removeSummary(cmd.entryId);
        this.sessions.delete(cmd.entryId);
        if (this.subscribed.delete(cmd.entryId)) {
          this.send({
            type: 'session.unavailable',
            entryId: cmd.entryId,
            error: makeError('ENTRY_NOT_FOUND'),
          });
        }
        return this.ok();
      }
      case 'session.setEffort':
      case 'session.close':
        return this.ok();
      case 'session.resume': {
        // WP-67: a sleeping session wakes (no prompt) – the info dialog's "start session".
        const summary = this.summaries.get(cmd.entryId);
        if (summary !== undefined && (summary.status.runState === 'sleeping' || summary.status.runState === 'error')) {
          this.patchSummary(cmd.entryId, {}, { runState: 'idle' });
        }
        return this.ok();
      }
      // ---- WP-67: session info, MCP actions, reloads (fake-session-info.ts) ----
      case 'session.info': {
        const gate = this.infoGate(cmd.entryId);
        if (gate !== null) return { ok: false, error: gate };
        const summary = this.summaries.get(cmd.entryId);
        if (summary === undefined || !this.info.available(cmd.section)) return this.ok({ available: false, data: null });
        return this.ok({ available: true, data: this.info.section(cmd.entryId, cmd.section, summary) });
      }
      case 'session.mcpAction': {
        const gate = this.infoGate(cmd.entryId);
        if (gate !== null) return { ok: false, error: gate };
        const failure = this.info.mcpAction(cmd.entryId, cmd.server, cmd.action);
        if (failure !== null) return { ok: false, error: makeError('CLAUDE_CONTROL_FAILED', { method: 'mcpAction', detail: failure }) };
        return this.ok();
      }
      case 'session.reload': {
        const gate = this.infoGate(cmd.entryId);
        if (gate !== null) return { ok: false, error: gate };
        const failure = this.info.reload(cmd.entryId, cmd.what);
        if (failure !== null) return { ok: false, error: makeError('CLAUDE_CONTROL_FAILED', { method: 'reload', detail: failure }) };
        return this.ok();
      }
      case 'transcript.loadEarlier': {
        // The server view keeps every item; snapshots are trimmed to LIMITS.snapshotItems.
        const view = this.view(cmd.entryId);
        if (view === null) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
        if (view.conversationId !== cmd.conversationId) return this.ok({ items: [], hasEarlier: false });
        const before = view.items.filter((item) => item.order < cmd.beforeOrder);
        const items = before.slice(Math.max(0, before.length - cmd.limit));
        return this.ok({ items, hasEarlier: before.length > items.length });
      }
      case 'session.getContext':
        return this.ok({ context: sampleContextBreakdown({ detail: cmd.detail }) });
      case 'session.refreshModels':
        return this.ok({ models: [sampleModelOption()] });
      case 'server.shutdown':
        return this.ok({ sessionsStopped: 0 });
      // ---- Phase 3 (WP-54): file service, plan versions, stop one task ----
      case 'file.stat': {
        if (!this.knowsEntry(cmd.entryId)) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
        const result = this.statFile(cmd.entryId, cmd.path);
        return result.ok ? this.ok({ file: result.file }) : { ok: false, error: result.error };
      }
      case 'file.statMany':
        if (!this.knowsEntry(cmd.entryId)) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
        return this.ok({ results: cmd.paths.map((path) => this.statFile(cmd.entryId, path)) });
      case 'file.open': {
        if (!this.knowsEntry(cmd.entryId)) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
        const result = this.statFile(cmd.entryId, cmd.path);
        if (!result.ok) return { ok: false, error: result.error };
        if (cmd.target === 'default' && !isDefaultProgramAllowed(cmd.path)) {
          return { ok: false, error: makeError('FILE_TYPE_BLOCKED') };
        }
        if (cmd.target !== 'explorer' && result.file.kind === 'directory') {
          return { ok: false, error: makeError('VALIDATION_FAILED', { path: 'path' }) };
        }
        this.fileOpens.push(cmd);
        return this.fileOpenError === null ? this.ok() : { ok: false, error: this.fileOpenError };
      }
      case 'files.session':
        if (!this.knowsEntry(cmd.entryId)) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
        return this.ok({ files: this.sessionFilesOf(cmd.entryId), truncated: this.sessionFilesTruncated });
      case 'files.project': {
        if (!this.knowsEntry(cmd.entryId)) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
        const root = this.summaries.get(cmd.entryId)?.cwd ?? FAKE_FILE_ROOT;
        const files = [...this.files.values()]
          .filter((file) => file.info.kind !== 'directory' && isWindowsPathInside(file.info.path, root))
          .map((file) =>
            file.info.path
              .slice(root.length)
              .replace(/^[\\/]+/, '')
              .replaceAll('\\', '/'),
          )
          .sort();
        return this.ok({ root, files, truncated: false, source: 'git' });
      }
      case 'editor.detect': {
        const editor = this.hostState.settings.editor;
        return this.ok({
          notepadpp: 'C:\\Program Files\\Notepad++\\notepad++.exe',
          vscode: null,
          custom:
            editor.preset === 'custom' && editor.executable !== null
              ? { executable: editor.executable, exists: true }
              : null,
        });
      }
      case 'plan.list':
        if (!this.knowsEntry(cmd.entryId)) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
        return this.ok({ versions: this.planVersions.map((version) => version.info) });
      case 'plan.read': {
        if (!this.knowsEntry(cmd.entryId)) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
        const version = this.planVersions.find((candidate) => candidate.info.version === cmd.version);
        if (version?.info.stored !== true) {
          return { ok: false, error: makeError('PLAN_NOT_FOUND', { version: cmd.version }) };
        }
        return this.ok({ version: cmd.version, text: version.text });
      }
      case 'session.stopTask':
        return this.stopTask(cmd.entryId, cmd.taskId);
      // WP-65: background moves, generated titles, links in the default browser.
      case 'session.backgroundTasks':
        return this.backgroundTasks(cmd.entryId, cmd.toolUseId);
      case 'session.regenerateTitle': {
        const summary = this.summaries.get(cmd.entryId);
        if (summary === undefined) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
        this.patchSummary(cmd.entryId, { title: `Generated: ${summary.title}`.slice(0, 200), titleSource: 'ai' });
        return this.ok();
      }
      case 'link.open':
        this.linkOpens.push(cmd.url);
        return this.linkOpenError === null ? this.ok() : { ok: false, error: this.linkOpenError };
      // WP-66: side questions and withdrawing a waiting message.
      case 'session.askSideQuestion':
        return this.ok({ itemId: this.askSideQuestion(cmd.entryId, cmd.question, cmd.threadId) });
      case 'session.cancelSideQuestion': {
        const item = this.view(cmd.entryId)?.items.find((i) => i.id === cmd.itemId);
        if (item?.kind === 'side_question' && item.status === 'pending') {
          this.pushOps(cmd.entryId, [{ op: 'item.upsert', item: { ...item, status: 'cancelled' } }]);
        }
        return this.ok();
      }
      case 'session.deleteSideQuestion': {
        const ids = (this.view(cmd.entryId)?.items ?? [])
          .filter((i) => i.kind === 'side_question' && i.threadId === cmd.threadId)
          .map((i) => i.id);
        if (ids.length > 0) this.pushOps(cmd.entryId, ids.map((itemId) => ({ op: 'item.remove' as const, itemId })));
        return this.ok();
      }
      case 'session.withdrawQueued': {
        const queue = this.view(cmd.entryId)?.detail.queue ?? [];
        const prompt = queue.find((q) => q.messageUuid === cmd.messageUuid);
        if (prompt === undefined) return this.ok({ withdrawn: false, text: null });
        this.pushOps(cmd.entryId, [
          { op: 'detail.patch', patch: { queue: queue.filter((q) => q.messageUuid !== cmd.messageUuid) } },
        ]);
        return this.ok({ withdrawn: true, text: prompt.text.text });
      }
      // Phase 2 commands (WP-30) included: the packages answer them in their tests via `onCommand`.
      case 'session.setFastMode':
      case 'session.switchConversation':
      case 'session.openExternal':
      case 'session.reclaim':
      case 'session.consoleCommand':
      case 'session.continueAfterLimit':
      case 'profile.get':
      case 'profile.save':
      case 'profile.delete':
      case 'profile.setDefault':
      case 'profile.test':
      case 'profile.validate':
      case 'fs.listDirectory':
        return { ok: false, error: makeError('NOT_IMPLEMENTED', { name: cmd.name satisfies CommandName }) };
    }
  }

  /**
   * WP-66: a pending side question (id like the engine's `px:<conversation>:<order>`); with
   * `replyToPrompts` (playground) answered a moment later. Returns its item id.
   */
  private askSideQuestion(entryId: EntryId, question: string, threadId: string | null): string {
    const order = this.nextOrder(entryId);
    const id = `px:fake:${String(order)}`;
    const item: SideQuestionItem = {
      kind: 'side_question',
      id,
      order,
      at: this.now(),
      parentToolUseId: null,
      threadId: threadId ?? id,
      question,
      status: 'pending',
      response: null,
      synthetic: false,
      fallbackModel: null,
      retry: null,
      error: null,
      answeredAt: null,
    };
    this.pushOps(entryId, [{ op: 'item.upsert', item }]);
    if (this.options.replyToPrompts === true) {
      this.later(() => {
        const current = this.view(entryId)?.items.find((i) => i.id === id);
        if (current?.kind !== 'side_question' || current.status !== 'pending') return;
        const response = `A playground side answer to “${question.slice(0, 80)}”. No model was called.`;
        const answered: SideQuestionItem = { ...current, status: 'answered', response, answeredAt: this.now() };
        this.pushOps(entryId, [{ op: 'item.upsert', item: answered }]);
      }, 600);
    }
    return id;
  }

  /** Adds the user message (and optionally a streamed reply); returns its messageUuid. */
  private acceptPrompt(entryId: EntryId, text: string, priority: 'next' | 'now'): string {
    const messageUuid = crypto.randomUUID();
    const order = this.nextOrder(entryId);
    const at = this.now();
    const userMessage: TranscriptItem = {
      kind: 'user_message',
      id: messageUuid,
      order,
      at,
      parentToolUseId: null,
      text: { text, truncated: null },
      attachments: [],
      origin: 'human',
      source: 'local',
      slashCommand: text.startsWith('/') ? (text.split(/\s/)[0] ?? null) : null,
      priority,
    };
    this.pushOps(entryId, [{ op: 'item.upsert', item: userMessage }]);
    this.patchSummary(entryId, { lastActivityAt: at }, { runState: 'working' });
    if (this.options.replyToPrompts === true) {
      const messageId = `msg_fake_${String(order)}`;
      this.later(() => {
        this.streamAssistantText(entryId, {
          item: {
            kind: 'assistant_text',
            id: `${messageId}:0`,
            order: order + 1,
            at: this.now(),
            parentToolUseId: null,
            messageId,
            blockIndex: 0,
            model: 'claude-haiku-5-5',
            text: '',
            streaming: true,
            aborted: false,
            localCommand: null,
          },
          text: `This is a playground reply to “${text.slice(0, 80)}”. No model was called.`,
          onDone: () => {
            this.patchSummary(entryId, { lastActivityAt: this.now() }, { runState: 'idle' });
          },
        });
      }, 300);
    }
    return messageUuid;
  }
}
