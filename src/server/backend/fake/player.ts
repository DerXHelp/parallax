/**
 * Player for fixture format v1 events (WP-13 §3.3, WP-02 §9.2) – the same one for recorded
 * fixtures, synthetic scenarios, the DSL and the interactive script. Gates: `input` (next send),
 * `canUseTool` (until the engine answers; `payload.fake.parallel` → join at the `decision`),
 * `control interrupt` (until interrupt()), `exit` with `msSinceClose` (until close()). Delays are
 * `Δt × speed`, counted again from each gate.
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  fixtureCallPayloadSchema,
  fixtureCanUseToolPayloadSchema,
  fixtureControlPayloadSchema,
  fixtureDecisionPayloadSchema,
  fixtureInputPayloadSchema,
  type FixtureEvent,
} from '../fixture';
import { toPermissionRequest } from '../permissionRequest';
import { SessionStopped, mapUuids, nextMacrotask, promptText, type RecordedAnswer } from './common';
import type { FakeSession } from './session';

export interface PlayerOptions {
  /** Emit exit{code:1, expected:false} right after the event with this seq was started. */
  crashAfterSeq?: number;
  /** Script mode: the turn signal (aborted → TurnInterrupted between events). */
  turnSignal?: AbortSignal;
  /** Top-level player of an events scenario: the first `call` per fn answers until one was played. */
  seedAnswers?: boolean;
}

type InterruptAnswer = { ok: true; stillQueued: string[] } | { ok: false; error: Error };

const fakePayloadSchema = z.looseObject({
  fake: z.looseObject({ parallel: z.boolean().optional() }).optional().catch(undefined),
});
const exitPayloadSchema = z.looseObject({
  code: z.number().int().nullable().optional().catch(undefined),
  signal: z.string().nullable().optional().catch(undefined),
  msSinceClose: z.number().optional().catch(undefined),
});
const abortPayloadSchema = z.looseObject({ toolUseID: z.string().optional().catch(undefined) });
const stderrPayloadSchema = z.looseObject({ data: z.string().catch('') });
const errorPayloadSchema = z.looseObject({ name: z.string().catch('Error'), message: z.string().catch('') });
const interruptResultSchema = z.looseObject({
  still_queued: z.array(z.string()).optional().catch(undefined),
});
const messagePayloadSchema = z.looseObject({ type: z.string().min(1) });

/** JSON with sorted object keys (order-insensitive comparison). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v: unknown) => canonical(v)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

type RecordedResult = z.infer<typeof fixtureDecisionPayloadSchema>['result'];

/**
 * Engine result vs. recording (§3.3 `decision`): behavior, message (deny), interrupt (deny),
 * updatedPermissions as a set, updatedInput deep. null = equal.
 */
export function compareDecision(expected: RecordedResult, actual: PermissionResult): string | null {
  if (expected.behavior !== actual.behavior)
    return `behavior ${actual.behavior} instead of ${expected.behavior}`;
  if (actual.behavior === 'deny') {
    if ((expected.message ?? '') !== actual.message) return 'message differs';
    if ((expected.interrupt ?? false) !== (actual.interrupt ?? false)) return 'interrupt differs';
    return null;
  }
  if (
    expected.updatedInput !== undefined &&
    canonical(expected.updatedInput) !== canonical(actual.updatedInput ?? {})
  ) {
    return 'updatedInput differs';
  }
  const set = (list: readonly unknown[] | undefined): string =>
    (list ?? [])
      .map((u) => canonical(u))
      .sort()
      .join('|');
  if (set(expected.updatedPermissions) !== set(actual.updatedPermissions)) return 'updatedPermissions differ';
  return null;
}

function promptTextOf(content: string | unknown[]): string {
  if (typeof content === 'string') return content;
  return content
    .flatMap((block) => {
      const text = z.looseObject({ type: z.literal('text'), text: z.string() }).safeParse(block);
      return text.success ? [text.data.text] : [];
    })
    .join('\n');
}

function answerOf(payload: { result?: unknown; error?: unknown }): RecordedAnswer {
  return payload.error === undefined ? { result: payload.result } : { error: payload.error };
}

export class EventPlayer {
  /** Index of the event being played (or waited for). */
  private index = 0;
  private interruptGate: { release(): void; answer: InterruptAnswer } | null = null;
  /** interrupt() calls that came before the player reached the gate at this index. */
  private readonly preReleased = new Map<number, PromiseWithResolvers<InterruptAnswer>>();
  /** Non-blocking canUseTool requests (`fake.parallel`), joined at their `decision`. */
  private readonly parallel = new Map<string, Promise<PermissionResult | null>>();

  constructor(
    private readonly session: FakeSession,
    private readonly events: readonly FixtureEvent[],
    private readonly options: PlayerOptions = {},
  ) {
    if (options.seedAnswers === true) {
      for (const event of events) {
        if (event.kind !== 'call') continue;
        const call = fixtureCallPayloadSchema.safeParse(event.payload);
        if (call.success && !session.firstCallAnswers.has(call.data.fn)) {
          session.firstCallAnswers.set(call.data.fn, answerOf(call.data));
        }
      }
    }
  }

  async play(): Promise<void> {
    this.session.pushPlayer(this);
    try {
      let previousT = 0;
      for (this.index = 0; this.index < this.events.length; this.index += 1) {
        const event = this.events[this.index];
        if (event === undefined) break;
        await this.session.delay(event.tMs - previousT, this.options.turnSignal);
        previousT = event.tMs;
        const work = this.dispatch(event);
        if (event.seq === this.options.crashAfterSeq) {
          await Promise.race([work.catch(() => undefined), nextMacrotask()]);
          this.session.crash(1);
          throw new SessionStopped();
        }
        await work;
      }
    } finally {
      this.session.popPlayer(this);
    }
  }

  /**
   * interrupt() of the engine: answers the gate the player waits at, or pre-releases the next
   * `control interrupt` before any other blocking event; null if there is none.
   */
  interrupt(): Promise<{ stillQueued: string[] }> | null {
    const gate = this.interruptGate;
    if (gate !== null) {
      this.interruptGate = null;
      gate.release();
      return settle(gate.answer);
    }
    for (let i = this.index; i < this.events.length; i += 1) {
      const event = this.events[i];
      if (event === undefined) break;
      if (event.kind === 'control' && this.isInterrupt(event)) {
        if (this.preReleased.has(i)) continue;
        const pending = Promise.withResolvers<InterruptAnswer>();
        this.preReleased.set(i, pending);
        return pending.promise.then(settle);
      }
      if (this.blocks(event)) return null;
    }
    return null;
  }

  private isInterrupt(event: FixtureEvent): boolean {
    const control = fixtureControlPayloadSchema.safeParse(event.payload);
    return control.success && control.data.method === 'interrupt';
  }

  private blocks(event: FixtureEvent): boolean {
    switch (event.kind) {
      case 'input':
        return true;
      case 'canUseTool':
        return fakePayloadSchema.safeParse(event.payload).data?.fake?.parallel !== true;
      case 'decision': {
        const decision = fixtureDecisionPayloadSchema.safeParse(event.payload);
        return decision.success && this.parallel.has(decision.data.toolUseID);
      }
      case 'exit':
        return exitPayloadSchema.safeParse(event.payload).data?.msSinceClose !== undefined;
      default:
        return false;
    }
  }

  private invalid(event: FixtureEvent, what: string): void {
    this.session.diagnostic('invalid-event', event.seq, `${event.kind} payload invalid: ${what}`);
  }

  private async dispatch(event: FixtureEvent): Promise<void> {
    switch (event.kind) {
      case 'message': {
        if (!messagePayloadSchema.safeParse(event.payload).success) {
          this.invalid(event, 'message without type');
          return;
        }
        this.session.emitMessage(mapUuids(event.payload, this.session.uuidMap));
        return;
      }
      case 'spawn':
        this.session.spawned();
        return;
      case 'input':
        await this.input(event);
        return;
      case 'canUseTool':
        await this.canUseTool(event);
        return;
      case 'decision':
        await this.decision(event);
        return;
      case 'control':
        await this.control(event);
        return;
      case 'call': {
        const call = fixtureCallPayloadSchema.safeParse(event.payload);
        if (call.success) this.session.callAnswers.set(call.data.fn, answerOf(call.data));
        else this.invalid(event, 'call');
        return;
      }
      case 'abort': {
        const abort = abortPayloadSchema.safeParse(event.payload);
        this.session.abortDecision(abort.success ? abort.data.toolUseID : undefined);
        return;
      }
      case 'stderr': {
        const stderr = stderrPayloadSchema.safeParse(event.payload);
        this.session.push({
          type: 'stderr',
          data: stderr.success ? stderr.data.data : '',
          at: this.session.now(),
        });
        return;
      }
      case 'error': {
        const error = errorPayloadSchema.safeParse(event.payload);
        this.session.push({
          type: 'error',
          where: 'iterator',
          name: error.success ? error.data.name : 'Error',
          message: error.success ? error.data.message : '',
          at: this.session.now(),
        });
        return;
      }
      case 'exit':
        await this.exit(event);
        return;
      case 'mark':
      case 'process':
        return;
    }
  }

  private async input(event: FixtureEvent): Promise<void> {
    const parsed = fixtureInputPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      this.invalid(event, 'input');
      return;
    }
    const recorded = parsed.data;
    const prompt = await this.session.waitInput(this.options.turnSignal);
    this.session.uuidMap.set(recorded.uuid, prompt.uuid);
    this.session.recordPrompt(prompt);
    const expectedText = promptTextOf(recorded.message.content);
    const actualText = promptText(prompt);
    if (expectedText !== actualText) {
      this.session.diagnostic('input-mismatch', event.seq, 'prompt text differs from the recording', {
        expected: expectedText,
        actual: actualText,
      });
    }
    const expectedPriority = recorded.priority === 'now' ? 'now' : 'next';
    if (expectedPriority !== prompt.priority) {
      this.session.diagnostic('input-mismatch', event.seq, 'prompt priority differs from the recording', {
        expected: expectedPriority,
        actual: prompt.priority,
      });
    }
  }

  private async canUseTool(event: FixtureEvent): Promise<void> {
    const parsed = fixtureCanUseToolPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      this.invalid(event, 'canUseTool');
      return;
    }
    const payload = parsed.data;
    const request = toPermissionRequest(payload.toolName, structuredClone(payload.input), payload.options);
    const decided = this.session.startDecision(request, event.seq);
    if (fakePayloadSchema.safeParse(event.payload).data?.fake?.parallel === true) {
      // Not blocking (subagents ask in parallel, A.6): the matching `decision` is the join point.
      this.parallel.set(request.toolUseId, decided);
      return;
    }
    await this.session.blockOn('waiting-decision', decided);
  }

  private async decision(event: FixtureEvent): Promise<void> {
    const parsed = fixtureDecisionPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      this.invalid(event, 'decision');
      return;
    }
    const { toolUseID, result: expected } = parsed.data;
    const pending = this.parallel.get(toolUseID);
    if (pending !== undefined) {
      this.parallel.delete(toolUseID);
      await this.session.blockOn('waiting-decision', pending);
    }
    if (!this.session.lastResults.has(toolUseID)) {
      this.session.diagnostic('decision-mismatch', event.seq, `no canUseTool result for ${toolUseID}`, {
        expected,
      });
      return;
    }
    const actual = this.session.lastResults.get(toolUseID) ?? null;
    if (actual === null) return; // aborted: the CLI no longer reads an answer
    const mismatch = compareDecision(expected, actual);
    if (mismatch !== null) {
      this.session.diagnostic('decision-mismatch', event.seq, mismatch, { expected, actual });
    }
  }

  private async control(event: FixtureEvent): Promise<void> {
    const parsed = fixtureControlPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      this.invalid(event, 'control');
      return;
    }
    const payload = parsed.data;
    if (payload.method !== 'interrupt') {
      this.session.queueControlAnswer(payload.method, answerOf(payload));
      return;
    }
    const answer = this.interruptAnswer(payload);
    const pre = this.preReleased.get(this.index);
    if (pre !== undefined) {
      this.preReleased.delete(this.index);
      pre.resolve(answer);
      return;
    }
    const gate = Promise.withResolvers<undefined>();
    this.interruptGate = {
      release: () => {
        gate.resolve(undefined);
      },
      answer,
    };
    try {
      await this.session.blockOn('waiting-control', gate.promise);
    } finally {
      this.interruptGate = null;
    }
  }

  private interruptAnswer(payload: { result?: unknown; error?: unknown }): InterruptAnswer {
    if (payload.error !== undefined) {
      const message = typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error);
      return { ok: false, error: new Error(message) };
    }
    const result = interruptResultSchema.safeParse(payload.result);
    const queued = result.success ? (result.data.still_queued ?? []) : [];
    // F.10: still_queued lists prompt UUIDs → the ones actually sent.
    return { ok: true, stillQueued: queued.map((uuid) => this.session.uuidMap.get(uuid) ?? uuid) };
  }

  private async exit(event: FixtureEvent): Promise<void> {
    const parsed = exitPayloadSchema.safeParse(event.payload);
    const payload = parsed.success ? parsed.data : {};
    if (payload.msSinceClose !== undefined) {
      await this.session.waitClose();
      this.session.exit(payload.code ?? 0, payload.signal ?? null, true);
    } else {
      this.session.exit(payload.code ?? 1, payload.signal ?? null, false);
    }
    throw new SessionStopped();
  }
}

function settle(answer: InterruptAnswer): Promise<{ stillQueued: string[] }> {
  return answer.ok ? Promise.resolve({ stillQueued: answer.stillQueued }) : Promise.reject(answer.error);
}
