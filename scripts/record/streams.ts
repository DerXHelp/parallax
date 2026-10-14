/**
 * Streamed content blocks (stream_event content_block_delta) split personal data across chunks,
 * e.g. an input_json_delta "C:\\Users\\Ja" followed by "ne\\…". The writer therefore sanitizes
 * the concatenation of every block and re-splits it into the same number of chunks, so the
 * concatenated deltas of a fixture always equal the sanitized final block.
 */

const DELTA_FIELDS = {
  text_delta: 'text',
  input_json_delta: 'partial_json',
  thinking_delta: 'thinking',
} as const;
type DeltaField = (typeof DELTA_FIELDS)[keyof typeof DELTA_FIELDS];

export interface DeltaRef {
  eventIndex: number;
  field: DeltaField;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function streamEvent(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload) || payload.type !== 'stream_event' || !isRecord(payload.event)) return undefined;
  return payload.event;
}

function deltaOf(payload: unknown): Record<string, unknown> | undefined {
  const event = streamEvent(payload);
  if (event?.type !== 'content_block_delta' || !isRecord(event.delta)) return undefined;
  return event.delta;
}

/** Groups the delta events of each streamed content block (in event order). */
export function deltaGroups(events: readonly { kind: string; payload: unknown }[]): DeltaRef[][] {
  const groups = new Map<string, DeltaRef[]>();
  const currentMessage = new Map<string, string>();
  events.forEach((entry, eventIndex) => {
    if (entry.kind !== 'message' || !isRecord(entry.payload)) return;
    const payload = entry.payload;
    const event = streamEvent(payload);
    if (event === undefined) return;
    const parent = typeof payload.parent_tool_use_id === 'string' ? payload.parent_tool_use_id : 'main';
    if (event.type === 'message_start' && isRecord(event.message) && typeof event.message.id === 'string') {
      currentMessage.set(parent, event.message.id);
    }
    const delta = deltaOf(payload);
    if (delta === undefined || typeof event.index !== 'number' || typeof delta.type !== 'string') return;
    const field = (DELTA_FIELDS as Record<string, DeltaField | undefined>)[delta.type];
    if (field === undefined || typeof delta[field] !== 'string') return;
    const messageId =
      typeof payload.api_message_id === 'string'
        ? payload.api_message_id
        : (currentMessage.get(parent) ?? '?');
    const key = `${parent}|${messageId}|${String(event.index)}`;
    const group = groups.get(key) ?? [];
    group.push({ eventIndex, field });
    groups.set(key, group);
  });
  return [...groups.values()];
}

export function getDeltaField(payload: unknown, field: DeltaField): string {
  const delta = deltaOf(payload);
  const value = delta?.[field];
  return typeof value === 'string' ? value : '';
}

export function setDeltaField(payload: unknown, field: DeltaField, value: string): void {
  const delta = deltaOf(payload);
  if (delta !== undefined) delta[field] = value;
}

/** Splits `text` into `lengths.length` parts with roughly proportional lengths (concatenation = text). */
export function resplit(text: string, lengths: readonly number[]): string[] {
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const parts: string[] = [];
  let offset = 0;
  let consumed = 0;
  lengths.forEach((length, index) => {
    consumed += length;
    const end =
      index === lengths.length - 1
        ? text.length
        : total === 0
          ? offset
          : Math.round((consumed / total) * text.length);
    parts.push(text.slice(offset, Math.max(offset, end)));
    offset = Math.max(offset, end);
  });
  return parts;
}
