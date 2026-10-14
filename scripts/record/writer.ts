/**
 * Fixture writer: collects events in memory and writes
 *  - the raw recording to .recordings/<stamp>/<scenario>.raw.jsonl (git-ignored, unsanitized),
 *  - the sanitized fixture to test/fixtures/sdk/<scenario>.jsonl (committed).
 * A fixture that still contains personal data after sanitizing is not written.
 * `resanitizeRaw` rebuilds a fixture from a raw recording (no live call needed).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { FIXTURE_VERSION, parseFixture, type EventKind, type FixtureHeader } from './format';
import type { Sanitizer } from './sanitize';
import { deltaGroups, getDeltaField, resplit, setDeltaField } from './streams';

interface RawEvent {
  seq: number;
  tMs: number;
  kind: EventKind;
  payload: unknown;
}

/** JSON round trip: drops functions/undefined and decouples the payload from live SDK objects. */
function toJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) => (inner instanceof Error ? inner.message : inner)),
  ) as unknown;
}

export interface WriteTargets {
  fixturesDir: string;
  recordingsDir: string;
}

/** Sanitizes header + events into fixture text; throws when personal data remains. */
export function sanitizeRecording(
  header: unknown,
  events: readonly RawEvent[],
  sanitizer: Sanitizer,
  name: string,
): string {
  // Learn secrets from the whole recording first, so values seen late are also replaced early.
  sanitizer.learn(header);
  for (const event of events) sanitizer.learn(event.payload);
  const clean = events.map((event) => ({ ...event, payload: sanitizer.value(event.payload) }));

  // Streamed blocks: sanitize the concatenation (secrets can span chunks) and re-split it.
  const joined: string[] = [];
  for (const group of deltaGroups(events)) {
    const rawParts = group.map((ref) => getDeltaField(events[ref.eventIndex]?.payload, ref.field));
    const cleanJoined = sanitizer.text(rawParts.join(''));
    joined.push(cleanJoined);
    const current = group.map((ref) => getDeltaField(clean[ref.eventIndex]?.payload, ref.field)).join('');
    if (current === cleanJoined) continue;
    const parts = resplit(
      cleanJoined,
      rawParts.map((part) => part.length),
    );
    group.forEach((ref, index) => {
      setDeltaField(clean[ref.eventIndex]?.payload, ref.field, parts[index] ?? '');
    });
  }

  const lines = [JSON.stringify(sanitizer.value(header)), ...clean.map((event) => JSON.stringify(event))];
  const text = `${lines.join('\n')}\n`;
  const leaks = sanitizer.findLeaks(`${text}\n${joined.join('\n')}`);
  if (leaks.length > 0) {
    throw new Error(`fixture ${name} still contains personal data: ${leaks.slice(0, 5).join('; ')}`);
  }
  parseFixture(text, name);
  return text;
}

/** Rebuilds the sanitized fixture text from a raw recording file's content. */
export function resanitizeRaw(rawText: string, sanitizer: Sanitizer, name: string): string {
  const parsed = parseFixture(rawText, name);
  return sanitizeRecording(parsed.header, parsed.events, sanitizer, name);
}

export class FixtureRecorder {
  private readonly events: RawEvent[] = [];
  private readonly t0 = performance.now();

  constructor(
    readonly scenario: string,
    private readonly meta: Omit<FixtureHeader, 'fixtureVersion' | 'scenario' | 'recordedAt' | 'options'>,
  ) {}

  /** Options shown in the header (set by the session; sanitized on write). */
  options: Record<string, unknown> = {};

  get size(): number {
    return this.events.length;
  }

  record(kind: EventKind, payload: unknown): void {
    this.events.push({
      seq: this.events.length + 1,
      tMs: Math.round(performance.now() - this.t0),
      kind,
      payload: toJson(payload),
    });
  }

  mark(label: string, extra: Record<string, unknown> = {}): void {
    this.record('mark', { label, ...extra });
  }

  private header(): FixtureHeader {
    return {
      fixtureVersion: FIXTURE_VERSION,
      scenario: this.scenario,
      ...this.meta,
      recordedAt: new Date().toISOString(),
      options: this.options,
    };
  }

  /** Writes raw + sanitized files; returns the fixture path. Throws when leaks remain. */
  write(targets: WriteTargets, sanitizer: Sanitizer): string {
    mkdirSync(targets.recordingsDir, { recursive: true });
    mkdirSync(targets.fixturesDir, { recursive: true });
    const header = this.header();
    const rawLines = [JSON.stringify(header), ...this.events.map((event) => JSON.stringify(event))];
    writeFileSync(path.join(targets.recordingsDir, `${this.scenario}.raw.jsonl`), `${rawLines.join('\n')}\n`);

    const target = path.join(targets.fixturesDir, `${this.scenario}.jsonl`);
    let text: string;
    try {
      text = sanitizeRecording(header, this.events, sanitizer, this.scenario);
    } catch (error) {
      rmSync(target, { force: true });
      throw error;
    }
    writeFileSync(target, text);
    return target;
  }
}
