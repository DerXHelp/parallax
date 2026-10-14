/**
 * Fixture format of test/fixtures/sdk/<scenario>.jsonl (documented in docs/sdk-findings.md).
 *
 * Line 1 is the header, every further line one event `{seq, tMs, kind, payload}`:
 * `seq` starts at 1 and has no gaps, `tMs` is milliseconds since the scenario started
 * (non-decreasing). Consumers (Normalizer snapshots, FakeBackend) must ignore unknown kinds.
 */
import { z } from 'zod';

export const FIXTURE_VERSION = 1;

export const EVENT_KINDS = [
  /** SDKMessage from the query iterator, unchanged except sanitizing. */
  'message',
  /** canUseTool callback invoked: `{toolName, input, options}` (options without `signal`). */
  'canUseTool',
  /** PermissionResult returned to the SDK: `{toolName, toolUseID, result}`. */
  'decision',
  /** SDKUserMessage pushed into the streaming input (incl. `uuid`, `priority`). */
  'input',
  /** State-changing Query method: `{method, args, result | error, ms}` (interrupt, setModel, …). */
  'control',
  /** Read-only call: `{fn, args, result | error, ms}` (getContextUsage, getSessionMessages, fs checks, …). */
  'call',
  /** stderr chunk: `{source: 'pipe' | 'callback', data}`. */
  'stderr',
  /** Error thrown by the iterator or the scenario: `{where, name, message}`. */
  'error',
  /** Abort: canUseTool signal aborted, fatal guard, timeout or budget: `{source, reason, …}`. */
  'abort',
  /** Scenario step marker: `{label, …}`. Purely informational. */
  'mark',
  /** CLI process spawned via spawnClaudeCodeProcess: `{pid, command, args, cwd}`. */
  'spawn',
  /** CLI process exited: `{pid, code, signal, msSinceClose}`. */
  'exit',
  /** Process-tree observation around close(): `{phase, rootPid, processes | survivors | killed}`. */
  'process',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const fixtureHeaderSchema = z.object({
  fixtureVersion: z.literal(FIXTURE_VERSION),
  scenario: z.string().min(1),
  description: z.string().optional(),
  sdkVersion: z.string().min(1),
  cliVersion: z.string().min(1),
  recordedAt: z.string().min(1),
  options: z.record(z.string(), z.unknown()),
});

export type FixtureHeader = z.infer<typeof fixtureHeaderSchema>;

export const fixtureEventSchema = z.object({
  seq: z.number().int().min(1),
  tMs: z.number().min(0),
  kind: z.enum(EVENT_KINDS),
  payload: z.unknown(),
});

export type FixtureEvent = z.infer<typeof fixtureEventSchema>;

const messagePayloadSchema = z.looseObject({ type: z.string().min(1) });

export interface ParsedFixture {
  header: FixtureHeader;
  events: FixtureEvent[];
}

/** Parses and validates one fixture file; throws with line numbers on any violation. */
export function parseFixture(text: string, name = 'fixture'): ParsedFixture {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const first = lines[0];
  if (first === undefined) throw new Error(`${name}: empty file`);

  const parseLine = (line: string, lineNo: number): unknown => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`${name}:${lineNo}: invalid JSON (${String(error)})`, { cause: error });
    }
  };

  const header = fixtureHeaderSchema.safeParse(parseLine(first, 1));
  if (!header.success) throw new Error(`${name}:1: invalid header: ${header.error.message}`);

  const events: FixtureEvent[] = [];
  let lastT = 0;
  lines.slice(1).forEach((line, index) => {
    const lineNo = index + 2;
    const parsed = fixtureEventSchema.safeParse(parseLine(line, lineNo));
    if (!parsed.success) throw new Error(`${name}:${lineNo}: invalid event: ${parsed.error.message}`);
    const event = parsed.data;
    const expectedSeq = events.length + 1;
    if (event.seq !== expectedSeq) {
      throw new Error(`${name}:${lineNo}: seq ${event.seq}, expected ${expectedSeq}`);
    }
    if (event.tMs < lastT) throw new Error(`${name}:${lineNo}: tMs ${event.tMs} < previous ${lastT}`);
    lastT = event.tMs;
    if (event.kind === 'message' && !messagePayloadSchema.safeParse(event.payload).success) {
      throw new Error(`${name}:${lineNo}: message payload without type`);
    }
    events.push(event);
  });

  return { header: header.data, events };
}
