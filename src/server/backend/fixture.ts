/**
 * SDK fixture format v1 (ADR-010): reading and validating test/fixtures/sdk/<scenario>.jsonl.
 * Single source of the format; scripts/record/format.ts re-exports it for the recorder.
 * Consumers: normalizer snapshots (WP-12), FakeBackend (WP-13). Design: docs/wp/WP-02.md §9.3,
 * format description: docs/sdk-findings.md "Fixture-Format".
 *
 * Line 1 is the header, every further line one event `{seq, tMs, kind, payload}`: `seq` starts
 * at 1 and has no gaps, `tMs` is milliseconds since the scenario started (non-decreasing).
 * Consumers must ignore unknown kinds.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
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

export interface ParsedFixture {
  header: FixtureHeader;
  events: FixtureEvent[];
}

// ---- Typed payload views (looseObject: tolerant, extra keys are kept) ----

/** `message`: any SDKMessage; only `type` is guaranteed. */
export const fixtureMessagePayloadSchema = z.looseObject({ type: z.string().min(1) });

/** `canUseTool`: `{toolName, input, options (without signal), signalAborted}`. */
export const fixtureCanUseToolPayloadSchema = z.looseObject({
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  options: z.looseObject({
    toolUseID: z.string().min(1),
    requestId: z.string().min(1),
    suggestions: z.array(z.unknown()).optional(),
    blockedPath: z.string().optional(),
    decisionReason: z.string().optional(),
    decisionReasonType: z.string().optional(),
    title: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    agentID: z.string().optional(),
    defaultToNo: z.boolean().optional(),
    suppressAlwaysAllowRule: z.boolean().optional(),
    requiresUserInteraction: z.boolean().optional(),
  }),
  signalAborted: z.boolean(),
});

/** `decision`: the PermissionResult given in the original run (reference / assertion). */
export const fixtureDecisionPayloadSchema = z.looseObject({
  toolName: z.string().min(1),
  toolUseID: z.string().min(1),
  result: z.looseObject({
    behavior: z.enum(['allow', 'deny']),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    updatedPermissions: z.array(z.unknown()).optional(),
    message: z.string().optional(),
    interrupt: z.boolean().optional(),
    decisionClassification: z.string().optional(),
  }),
});

/** `input`: the pushed SDKUserMessage. */
export const fixtureInputPayloadSchema = z.looseObject({
  type: z.literal('user'),
  message: z.looseObject({ role: z.literal('user'), content: z.union([z.string(), z.array(z.unknown())]) }),
  uuid: z.string().min(1),
  priority: z.string().optional(),
  origin: z.unknown().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
});

/** `control`: state-changing Query method and its answer. */
export const fixtureControlPayloadSchema = z.looseObject({
  method: z.string().min(1),
  args: z.array(z.unknown()),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  ms: z.number().nonnegative(),
});

/** `call`: read-only call and its answer. */
export const fixtureCallPayloadSchema = z.looseObject({
  fn: z.string().min(1),
  args: z.array(z.unknown()),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  ms: z.number().nonnegative(),
});

// ---- Parsing / loading ----

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
    if (event.kind === 'message' && !fixtureMessagePayloadSchema.safeParse(event.payload).success) {
      throw new Error(`${name}:${lineNo}: message payload without type`);
    }
    events.push(event);
  });

  return { header: header.data, events };
}

/** `<repoRoot>/test/fixtures/sdk`. */
export function fixturesDir(repoRoot: string): string {
  return path.join(repoRoot, 'test', 'fixtures', 'sdk');
}

/** Reads and validates one fixture file (`<dir>/<scenario>.jsonl`). */
export async function loadFixture(file: string): Promise<ParsedFixture> {
  const text = await readFile(file, 'utf8');
  return parseFixture(text, path.basename(file));
}

/** Scenario names (file names without `.jsonl`), sorted. */
export async function listFixtureScenarios(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
    .sort();
}
