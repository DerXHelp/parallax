import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import { elicitationFieldSchema, type ElicitationField } from '@shared/model';
import type { ElicitationRequestInfo } from '../../backend/types';
import { checkElicitationContent, normalizeElicitation } from './elicitation';

function request(p: Partial<ElicitationRequestInfo> = {}): ElicitationRequestInfo {
  return {
    serverName: 'booking',
    message: 'Please enter the details.',
    mode: 'form',
    url: null,
    elicitationId: null,
    requestedSchema: null,
    title: null,
    displayName: null,
    description: null,
    requestId: 'req-1',
    ...p,
  };
}

const form = (properties: Record<string, unknown>, required: string[] = []) =>
  normalizeElicitation(request({ requestedSchema: { type: 'object', properties, required } }));

describe('normalizeElicitation – form subset (ADR-256)', () => {
  it('takes over string, integer, number, boolean and enum fields in schema order', () => {
    const n = form(
      {
        name: {
          type: 'string',
          title: 'Name',
          description: 'Full name',
          minLength: 1,
          maxLength: 80,
          default: 'Ada',
        },
        email: { type: 'string', format: 'email' },
        guests: { type: 'integer', minimum: 1, maximum: 12, default: 2 },
        price: { type: 'number', minimum: 0.5 },
        vegetarian: { type: 'boolean', default: false },
        time: {
          type: 'string',
          oneOf: [{ const: '18:00', title: '6 pm' }, { const: '19:00' }],
          default: '19:00',
        },
        size: { type: 'string', enum: ['s', 'm'], enumNames: ['Small', 'Medium'] },
      },
      ['name', 'guests'],
    );
    expect(n.unsupported).toBeNull();
    expect(n.fields.map((f) => [f.key, f.type, f.required])).toEqual([
      ['name', 'string', true],
      ['email', 'string', false],
      ['guests', 'integer', true],
      ['price', 'number', false],
      ['vegetarian', 'boolean', false],
      ['time', 'enum', false],
      ['size', 'enum', false],
    ]);
    expect(n.fields[0]).toMatchObject({
      title: 'Name',
      description: 'Full name',
      minLength: 1,
      maxLength: 80,
      default: 'Ada',
    });
    expect(n.fields[1]?.format).toBe('email');
    expect(n.fields[2]).toMatchObject({ minimum: 1, maximum: 12, default: 2 });
    expect(n.fields[5]).toMatchObject({
      enumValues: ['18:00', '19:00'],
      enumNames: ['6 pm', '19:00'],
      default: '19:00',
    });
    expect(n.fields[6]).toMatchObject({ enumValues: ['s', 'm'], enumNames: ['Small', 'Medium'] });
    for (const field of n.fields) expect(elicitationFieldSchema.parse(field)).toEqual(field);
  });

  it('drops unknown keywords, unknown formats and defaults of the wrong type', () => {
    const n = form({
      a: { type: 'string', format: 'hostname', pattern: '^x$', default: 3 },
      b: { type: 'integer', default: 1.5 },
      c: { type: 'string', enum: ['x'], default: 'y' },
    });
    expect(n.unsupported).toBeNull();
    expect(n.fields[0]).toMatchObject({ format: null, default: null });
    expect(n.fields[1]?.default).toBeNull();
    expect(n.fields[2]?.default).toBeNull();
  });

  it('no schema or no properties = a form without fields', () => {
    expect(normalizeElicitation(request()).fields).toEqual([]);
    expect(normalizeElicitation(request({ requestedSchema: { type: 'object' } })).fields).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['multi-select arrays', { t: { type: 'array', items: { type: 'string' } } }, /type array/],
    ['nested objects', { o: { type: 'object', properties: {} } }, /type object/],
    ['a field without type', { x: { title: 'X' } }, /no type/],
    ['non-string enum values', { e: { type: 'string', enum: [1, 2] } }, /strings/],
    ['an empty enum', { e: { type: 'string', enum: [] } }, /empty enum/],
    ['oneOf without const', { e: { type: 'string', oneOf: [{ title: 'A' }] } }, /const/],
  ])('%s → unsupported, only decline', (_label, properties, reason) => {
    const n = form(properties);
    expect(n.fields).toEqual([]);
    expect(n.unsupported).toMatch(reason);
  });

  it('too many fields or enum values → unsupported', () => {
    const many = Object.fromEntries(
      Array.from({ length: LIMITS.elicitationFieldsMax + 1 }, (_, i) => [
        `f${String(i)}`,
        { type: 'string' },
      ]),
    );
    expect(form(many).unsupported).toMatch(/more than/);
    const values = Array.from({ length: LIMITS.elicitationEnumMax + 1 }, (_, i) => `v${String(i)}`);
    expect(form({ e: { type: 'string', enum: values } }).unsupported).toMatch(/more than/);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'SR5: a field named %s is unsupported (never a key of the zod shape)',
    (key) => {
      // JSON.parse makes `__proto__` an own key, like the SDK's parsed request.
      const properties: unknown = JSON.parse(`{"${key}": {"type": "string"}, "name": {"type": "string"}}`);
      const n = normalizeElicitation(
        request({ requestedSchema: { type: 'object', properties, required: [key] } }),
      );
      expect(n.fields).toEqual([]);
      expect(n.unsupported).toBe(`field "${key}": reserved name`);
    },
  );

  it('a schema that is not an object → unsupported', () => {
    expect(normalizeElicitation(request({ requestedSchema: { type: 'string' } })).unsupported).toMatch(
      /object/,
    );
  });

  it('caps texts to the decision schema and keeps an unknown server name valid', () => {
    const n = normalizeElicitation(
      request({
        serverName: '',
        message: 'm'.repeat(LIMITS.elicitationMessageChars + 5),
        title: 't'.repeat(600),
      }),
    );
    expect(n.serverName).toBe('unknown');
    expect(n.message).toHaveLength(LIMITS.elicitationMessageChars);
    expect(n.title).toHaveLength(500);
  });

  it('never splits a surrogate pair when capping', () => {
    const n = normalizeElicitation(request({ displayName: `${'a'.repeat(199)}😀` }));
    expect(n.displayName).toBe('a'.repeat(199));
  });
});

describe('normalizeElicitation – url mode', () => {
  it('keeps an http(s) URL and the elicitation id', () => {
    const n = normalizeElicitation(
      request({ mode: 'url', url: 'https://auth.example/x?y=1', elicitationId: 'el-1' }),
    );
    expect(n).toMatchObject({
      mode: 'url',
      url: 'https://auth.example/x?y=1',
      elicitationId: 'el-1',
      unsupported: null,
    });
    expect(n.fields).toEqual([]);
  });

  it.each(['file:///C:/Windows/system32', 'javascript:alert(1)', 'ftp://example.invalid/x', ''])(
    'rejects %s as unsupported',
    (url) => {
      const n = normalizeElicitation(request({ mode: 'url', url }));
      expect(n.url).toBeNull();
      expect(n.unsupported).not.toBeNull();
    },
  );

  it('an over-long elicitation id is not sent to the web (null), the URL stays', () => {
    const n = normalizeElicitation(
      request({ mode: 'url', url: 'https://auth.example/', elicitationId: 'x'.repeat(201) }),
    );
    expect(n.elicitationId).toBeNull();
    expect(n.url).toBe('https://auth.example/');
  });
});

describe('checkElicitationContent', () => {
  const fields: ElicitationField[] = form(
    {
      name: { type: 'string', minLength: 2, maxLength: 5 },
      email: { type: 'string', format: 'email' },
      day: { type: 'string', format: 'date' },
      guests: { type: 'integer', minimum: 1, maximum: 4 },
      price: { type: 'number' },
      vegetarian: { type: 'boolean' },
      time: { type: 'string', enum: ['18:00', '19:00'] },
    },
    ['name'],
  ).fields;

  it('accepts a valid answer and drops nothing it knows', () => {
    const r = checkElicitationContent(fields, {
      name: 'Ada',
      email: 'ada@example.invalid',
      day: '2026-11-21',
      guests: 2,
      price: 9.5,
      vegetarian: true,
      time: '19:00',
    });
    expect(r).toEqual({
      ok: true,
      content: {
        name: 'Ada',
        email: 'ada@example.invalid',
        day: '2026-11-21',
        guests: 2,
        price: 9.5,
        vegetarian: true,
        time: '19:00',
      },
    });
  });

  it.each<[string, Record<string, string | number | boolean> | null, string]>([
    ['a missing required field', {}, 'content.name'],
    ['null content with a required field', null, 'content.name'],
    ['a too short string', { name: 'A' }, 'content.name'],
    ['a too long string', { name: 'Adalbert' }, 'content.name'],
    ['a wrong type', { name: 3 }, 'content.name'],
    ['a bad email', { name: 'Ada', email: 'nope' }, 'content.email'],
    ['a bad date', { name: 'Ada', day: '21.11.2026' }, 'content.day'],
    ['a non-integer', { name: 'Ada', guests: 1.5 }, 'content.guests'],
    ['a number out of range', { name: 'Ada', guests: 9 }, 'content.guests'],
    ['a value outside the enum', { name: 'Ada', time: '20:00' }, 'content.time'],
    ['an unknown key', { name: 'Ada', extra: 'x' }, 'content.extra'],
  ])('rejects %s', (_label, content, path) => {
    const r = checkElicitationContent(fields, content);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'DECISION_OPTION_UNAVAILABLE', params: { path } });
  });

  it('a form without fields accepts {} and null', () => {
    expect(checkElicitationContent([], null)).toEqual({ ok: true, content: {} });
    expect(checkElicitationContent([], {})).toEqual({ ok: true, content: {} });
  });

  it('SR5: a restored field named __proto__ is refused; the answer object never gets a prototype key', () => {
    const proto = elicitationFieldSchema.parse({ ...fields[0], key: '__proto__', required: true });
    const content: Record<string, string> = JSON.parse('{"__proto__": "x"}') as Record<string, string>;
    expect(checkElicitationContent([proto], content)).toEqual({
      ok: false,
      error: { code: 'ELICITATION_UNSUPPORTED', params: { reason: 'reserved field name' } },
    });
    const ok = checkElicitationContent(fields, { name: 'Ada' });
    expect(ok.ok && Object.getPrototypeOf(ok.content)).toBe(Object.prototype);
  });
});
