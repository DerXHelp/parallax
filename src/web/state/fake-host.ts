import { LIMITS, type EntryId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type {
  AssistantTextItem,
  Decision,
  DecisionOutcome,
  DecisionResponse,
  HostState,
  SessionSummary,
  TranscriptItem,
} from '@shared/model';
import type {
  ClientHelloMessage,
  ClientMessage,
  Command,
  CommandName,
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
  sampleHello,
  sampleHostState,
  sampleId,
  sampleModelOption,
  sampleSummary,
  sampleTime,
} from '@shared/samples';
import { applySessionOp, trimItems, viewStateFromSnapshot, type SessionViewState } from '@shared/sync';
import { pathTail } from '@web/lib/path-display';
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
        edited: response.response.behavior === 'approve' && response.response.editedPlan !== null,
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
  private handshaken = false;
  private nextEntry = 100;

  constructor(options: FakeHostOptions) {
    this.options = options;
    this.transport = options.transport;
    this.serverInstanceId = options.serverInstanceId ?? SAMPLE_IDS.serverInstanceId;
    this.buildId = options.buildId ?? 'dev';
    this.hostState = options.hostState ?? sampleHostState();
    for (const summary of options.summaries ?? []) this.summaries.set(summary.entryId, summary);
    for (const snapshot of options.sessions ?? []) this.addSession(snapshot);
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
   * Returns a cancel function.
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
    const step = () => {
      if (cancelled) return;
      const chunk = chunks[index];
      if (chunk === undefined) {
        this.pushOps(entryId, [
          { op: 'item.upsert', item: { ...options.item, text: options.text, streaming: false } },
        ]);
        options.onDone?.();
        return;
      }
      index++;
      this.pushOps(entryId, [{ op: 'item.delta', itemId: options.item.id, field: 'text', append: chunk }]);
      this.later(step, intervalMs);
    };
    this.later(step, intervalMs);
    return () => {
      cancelled = true;
    };
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
        const ack = this.options.onCommand?.(message.cmd, this) ?? this.defaultCommand(message.cmd);
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
        this.pushOps(cmd.entryId, [
          {
            op: 'decision.resolved',
            decisionId: decision.id,
            outcome,
            byClientId: this.clientHello?.clientId ?? null,
            at: this.now(),
          },
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
      case 'session.setEffort':
      case 'session.close':
      case 'session.resume':
        return this.ok();
      case 'transcript.loadEarlier':
        return this.ok({ items: [], hasEarlier: false });
      case 'session.getContext':
        return this.ok({ context: sampleContextBreakdown({ detail: cmd.detail }) });
      case 'session.refreshModels':
        return this.ok({ models: [sampleModelOption()] });
      case 'server.shutdown':
        return this.ok({ sessionsStopped: 0 });
      case 'session.setFastMode':
        return { ok: false, error: makeError('NOT_IMPLEMENTED', { name: cmd.name satisfies CommandName }) };
    }
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
