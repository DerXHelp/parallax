/**
 * Test helpers of the FakeBackend (WP-13 §3.3; only tests import this): load a recorded fixture,
 * answer canUseTool with the recorded decisions (Fake tests without broker), and drive a session
 * through its gates like the recorder did (send the recorded prompts, interrupt at the interrupt
 * gate, close at the exit gate).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  fixtureDecisionPayloadSchema,
  fixtureInputPayloadSchema,
  fixturesDir,
  loadFixture,
  type FixtureEvent,
  type ParsedFixture,
} from '../fixture';
import { permissionUpdateSchema } from '../permissionRequest';
import type { AgentSession, BackendEvent, OutgoingPrompt, PermissionHandler } from '../types';
import type { FakeBackend, FakeSessionHandle } from './types';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** `test/fixtures/sdk/<name>.jsonl`, validated (fixture format v1). */
export function loadFixtureScenario(name: string): Promise<ParsedFixture> {
  return loadFixture(path.join(fixturesDir(REPO_ROOT), `${name}.jsonl`));
}

const classificationSchema = z
  .enum(['user_temporary', 'user_permanent', 'user_reject'])
  .optional()
  .catch(undefined);

/** A recorded `decision.result` → typed PermissionResult (tolerant). */
export function recordedResult(raw: unknown): PermissionResult | null {
  const parsed = fixtureDecisionPayloadSchema.shape.result.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  const decisionClassification = classificationSchema.parse(r.decisionClassification);
  if (r.behavior === 'deny') {
    return {
      behavior: 'deny',
      message: r.message ?? '',
      ...(r.interrupt === undefined ? {} : { interrupt: r.interrupt }),
      ...(decisionClassification === undefined ? {} : { decisionClassification }),
    };
  }
  const updates = (r.updatedPermissions ?? []).flatMap((u) => {
    const update = permissionUpdateSchema.safeParse(u);
    return update.success ? [update.data] : [];
  });
  return {
    behavior: 'allow',
    ...(r.updatedInput === undefined ? {} : { updatedInput: r.updatedInput }),
    ...(r.updatedPermissions === undefined ? {} : { updatedPermissions: updates }),
    ...(decisionClassification === undefined ? {} : { decisionClassification }),
  };
}

/** PermissionHandler that answers with the recorded `decision` per toolUseID. */
export function fixtureDecisionResponder(parsed: Pick<ParsedFixture, 'events'>): PermissionHandler {
  const recorded = new Map<string, PermissionResult>();
  for (const event of parsed.events) {
    if (event.kind !== 'decision') continue;
    const decision = fixtureDecisionPayloadSchema.safeParse(event.payload);
    const result = decision.success ? recordedResult(decision.data.result) : null;
    if (decision.success && result !== null) recorded.set(decision.data.toolUseID, result);
  }
  return (req) => {
    const result = recorded.get(req.toolUseId);
    return Promise.resolve(
      result === undefined
        ? { behavior: 'deny', message: `no recorded decision for ${req.toolUseId}` }
        : structuredClone(result),
    );
  };
}

/** The recorded prompts of a fixture as OutgoingPrompts (text, priority) with fresh uuids. */
export function recordedPrompts(events: readonly FixtureEvent[], newUuid: () => string): OutgoingPrompt[] {
  return events.flatMap((event) => {
    if (event.kind !== 'input') return [];
    const input = fixtureInputPayloadSchema.safeParse(event.payload);
    if (!input.success) return [];
    const content = input.data.message.content;
    const text =
      typeof content === 'string'
        ? content
        : content
            .flatMap((b) => {
              const t = z.looseObject({ type: z.literal('text'), text: z.string() }).safeParse(b);
              return t.success ? [t.data.text] : [];
            })
            .join('\n');
    return [
      {
        uuid: newUuid(),
        content: [{ type: 'text', text }],
        priority: input.data.priority === 'now' ? 'now' : 'next',
      },
    ];
  });
}

export interface DriveResult {
  /** Every backend event of the session, in order (exit last). */
  events: BackendEvent[];
  /** The prompts actually sent, in order. */
  sent: OutgoingPrompt[];
}

/**
 * Serves the gates of ONE session like the recorder: input → next recorded prompt, control
 * interrupt → interrupt(), exit gate → close(); waits with `backend.settle()` in between.
 * Consumes `session.events` (the single consumer) and returns them after the exit.
 */
export async function driveFixtureSession(
  backend: FakeBackend,
  agent: AgentSession,
  handle: FakeSessionHandle,
  prompts: readonly OutgoingPrompt[],
  o: { maxSteps?: number } = {},
): Promise<DriveResult> {
  const collected: BackendEvent[] = [];
  const consumer = (async () => {
    for await (const event of agent.events) collected.push(event);
  })();
  const queue = [...prompts];
  const sent: OutgoingPrompt[] = [];
  for (let step = 0; step < (o.maxSteps ?? 1000); step += 1) {
    await backend.settle();
    if (handle.state === 'exited') break;
    if (handle.state === 'waiting-input') {
      const prompt = queue.shift();
      if (prompt === undefined) {
        await agent.close();
        break;
      }
      sent.push(prompt);
      agent.send(prompt);
    } else if (handle.state === 'waiting-control') {
      await agent.interrupt();
    } else if (handle.state === 'waiting-close') {
      await agent.close();
    } else if (handle.state === 'waiting-decision') {
      throw new Error(`session ${handle.entryId} hangs at an unanswered decision`);
    }
  }
  await consumer;
  return { events: collected, sent };
}
