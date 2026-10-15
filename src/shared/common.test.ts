import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  LOCAL_HOST_ID,
  STANDARD_PROFILE_ID,
  blobIdSchema,
  claudeSessionIdSchema,
  clientIdSchema,
  cmdIdSchema,
  conversationIdSchema,
  decisionIdSchema,
  entryIdSchema,
  hostIdSchema,
  isoDateTimeSchema,
  itemIdSchema,
  jsonValueSchema,
  makeSessionKey,
  paramsSchema,
  parseSessionKey,
  profileIdSchema,
} from './common';

const hex32 = '0123456789abcdef0123456789abcdef';

describe('prefixed ids', () => {
  const cases = [
    ['en', entryIdSchema],
    ['cv', conversationIdSchema],
    ['dc', decisionIdSchema],
    ['cl', clientIdSchema],
  ] as const;

  it.each(cases)('%s_ + 32 lower-case hex', (prefix, schema) => {
    expect(schema.safeParse(`${prefix}_${hex32}`).success).toBe(true);
    expect(schema.safeParse(`${prefix}_${hex32.toUpperCase()}`).success).toBe(false);
    expect(schema.safeParse(`${prefix}_${hex32.slice(1)}`).success).toBe(false);
    expect(schema.safeParse(`${prefix}_${hex32}0`).success).toBe(false);
    expect(schema.safeParse(`xx_${hex32}`).success).toBe(false);
    expect(schema.safeParse(hex32).success).toBe(false);
    expect(schema.safeParse(` ${prefix}_${hex32}`).success).toBe(false);
  });

  it('does not accept the id of another kind', () => {
    expect(entryIdSchema.safeParse(`cv_${hex32}`).success).toBe(false);
    expect(conversationIdSchema.safeParse(`en_${hex32}`).success).toBe(false);
  });

  it('profile id: standard or pf_ + 32 hex', () => {
    expect(profileIdSchema.safeParse(STANDARD_PROFILE_ID).success).toBe(true);
    expect(profileIdSchema.safeParse(`pf_${hex32}`).success).toBe(true);
    expect(profileIdSchema.safeParse('Standard').success).toBe(false);
    expect(profileIdSchema.safeParse(`en_${hex32}`).success).toBe(false);
  });
});

describe('other ids', () => {
  it('cmdId is a UUID', () => {
    expect(cmdIdSchema.safeParse('9b779de6-56fb-42f9-af06-3db55a33470f').success).toBe(true);
    expect(cmdIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('blob id is 64 lower-case hex', () => {
    expect(blobIdSchema.safeParse(hex32 + hex32).success).toBe(true);
    expect(blobIdSchema.safeParse((hex32 + hex32).toUpperCase()).success).toBe(false);
    expect(blobIdSchema.safeParse(hex32).success).toBe(false);
  });

  it('claude session id is a non-empty string without UUID constraint', () => {
    expect(claudeSessionIdSchema.safeParse('a2aa36f5-56fb-42f9-af06-3db55a33470f').success).toBe(true);
    expect(claudeSessionIdSchema.safeParse('anything').success).toBe(true);
    expect(claudeSessionIdSchema.safeParse('').success).toBe(false);
    expect(claudeSessionIdSchema.safeParse('x'.repeat(101)).success).toBe(false);
  });

  it('item id length 1–200', () => {
    expect(itemIdSchema.safeParse('msg_01:0').success).toBe(true);
    expect(itemIdSchema.safeParse('').success).toBe(false);
    expect(itemIdSchema.safeParse('x'.repeat(201)).success).toBe(false);
  });

  it('host id: lower-case, no colon', () => {
    expect(hostIdSchema.safeParse(LOCAL_HOST_ID).success).toBe(true);
    expect(hostIdSchema.safeParse('work-pc-2').success).toBe(true);
    expect(hostIdSchema.safeParse('a:b').success).toBe(false);
    expect(hostIdSchema.safeParse('-x').success).toBe(false);
    expect(hostIdSchema.safeParse('Local').success).toBe(false);
    expect(hostIdSchema.safeParse('x'.repeat(33)).success).toBe(false);
  });
});

describe('session keys', () => {
  const entryId = `en_${hex32}`;

  it('round-trips hostId:entryId', () => {
    const key = makeSessionKey(LOCAL_HOST_ID, entryId);
    expect(key).toBe(`local:${entryId}`);
    expect(parseSessionKey(key)).toEqual({ hostId: 'local', entryId });
  });

  it.each([
    'local',
    `local${entryId}`,
    `:${entryId}`,
    `local:`,
    `Local:${entryId}`,
    `local:${entryId}:x`,
    `local:cv_${hex32}`,
    `a:b:${entryId}`,
  ])('rejects malformed key %s', (key) => {
    expect(parseSessionKey(key)).toBeNull();
  });
});

describe('time, JSON, params', () => {
  it('accepts toISOString() output and offsets', () => {
    expect(isoDateTimeSchema.safeParse(new Date(0).toISOString()).success).toBe(true);
    expect(isoDateTimeSchema.safeParse('2026-10-15T10:00:00+02:00').success).toBe(true);
    expect(isoDateTimeSchema.safeParse('2026-10-15').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('yesterday').success).toBe(false);
  });

  it('accepts JSON values only', () => {
    expect(jsonValueSchema.safeParse({ a: [1, 'x', null, { b: true }] }).success).toBe(true);
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(jsonValueSchema.safeParse({ f: () => 1 }).success).toBe(false);
  });

  it('params allow only scalars', () => {
    expect(paramsSchema.safeParse({ a: 'x', b: 1, c: true, d: null }).success).toBe(true);
    expect(paramsSchema.safeParse({ a: { nested: true } }).success).toBe(false);
  });
});

describe('limits', () => {
  it('item cap lies within the plan corridor 32–64 KB', () => {
    expect(LIMITS.itemTextChars).toBeGreaterThanOrEqual(32 * 1024);
    expect(LIMITS.itemTextChars).toBeLessThanOrEqual(64 * 1024);
    expect(LIMITS.deltaFlushMs).toBeGreaterThanOrEqual(30);
    expect(LIMITS.deltaFlushMs).toBeLessThanOrEqual(50);
    expect(LIMITS.snapshotItems).toBeLessThanOrEqual(LIMITS.ringBufferOps);
  });
});
