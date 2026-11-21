import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import type { ElicitationField } from '@shared/model';
import { sampleDecisions, sampleResponses } from '@shared/samples';
import { t } from '@web/i18n';
import {
  checkElicitationDraft,
  elicitationControl,
  elicitationHints,
  elicitationServerText,
  elicitationTitle,
  elicitationUrlTarget,
  fieldKeyOfError,
  initialElicitationDraft,
  isoToLocalDateTime,
  localDateTimeToIso,
  type ElicitationDraftValue,
} from './elicitation';

const FORM = sampleDecisions.elicitationForm();

/** A field of the MCP subset with every keyword absent (null) unless given. */
function field(p: Partial<ElicitationField> & Pick<ElicitationField, 'key' | 'type'>): ElicitationField {
  return {
    title: null,
    description: null,
    required: false,
    enumValues: null,
    enumNames: null,
    format: null,
    minimum: null,
    maximum: null,
    minLength: null,
    maxLength: null,
    default: null,
    ...p,
  };
}

function draftOf(entries: Record<string, ElicitationDraftValue>) {
  return new Map(Object.entries(entries));
}

function issueCodes(fields: readonly ElicitationField[], draft: Record<string, ElicitationDraftValue>) {
  const result = checkElicitationDraft(fields, draftOf(draft));
  return result.ok ? {} : Object.fromEntries([...result.issues].map(([key, issue]) => [key, issue.code]));
}

describe('elicitation helpers (WP-116)', () => {
  it('picks a control per field: radio up to 5 enum values, a select above, one line up to 200 characters', () => {
    expect(FORM.fields.map(elicitationControl)).toEqual(['radio', 'number', 'checkbox', 'email']);
    const values = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(elicitationControl(field({ key: 'e', type: 'enum', enumValues: values }))).toBe('select');
    expect(elicitationControl(field({ key: 'e', type: 'enum', enumValues: values.slice(0, 5) }))).toBe(
      'radio',
    );
    expect(elicitationControl(field({ key: 's', type: 'string', maxLength: 200 }))).toBe('text');
    expect(elicitationControl(field({ key: 's', type: 'string', maxLength: 201 }))).toBe('multiline');
    expect(elicitationControl(field({ key: 's', type: 'string' }))).toBe('multiline');
    expect(elicitationControl(field({ key: 's', type: 'string', format: 'uri' }))).toBe('url');
    expect(elicitationControl(field({ key: 's', type: 'string', format: 'date' }))).toBe('date');
    expect(elicitationControl(field({ key: 's', type: 'string', format: 'date-time' }))).toBe('datetime');
    expect(elicitationControl(field({ key: 'n', type: 'number' }))).toBe('number');
  });

  it('fills the draft with the defaults (enum as the index of its value) and sends them', () => {
    const draft = initialElicitationDraft(FORM.fields);
    expect(Object.fromEntries(draft)).toEqual({ project: '0', priority: '3', notify: false, contact: '' });
    expect(checkElicitationDraft(FORM.fields, draft)).toEqual({
      ok: true,
      // The empty optional "contact" is left out; the unchecked box is sent as false.
      response: { action: 'accept', content: { project: 'web', priority: 3, notify: false } },
    });
  });

  it('builds the contract answer of the sample', () => {
    const result = checkElicitationDraft(
      FORM.fields,
      draftOf({ project: '1', priority: '2', notify: true, contact: '' }),
    );
    expect(result).toEqual({ ok: true, response: sampleResponses.elicitationAccept.response });
  });

  it('drops defaults that do not fit the field', () => {
    const fields = [
      field({ key: 'e', type: 'enum', enumValues: ['a'], default: 'zzz' }),
      field({ key: 'd', type: 'string', format: 'date', default: 'tomorrow' }),
      field({ key: 'dt', type: 'string', format: 'date-time', default: 'soon' }),
      field({ key: 's', type: 'string', maxLength: 3, default: 'abcdef' }),
    ];
    expect(Object.fromEntries(initialElicitationDraft(fields))).toEqual({ e: '', d: '', dt: '', s: 'abc' });
  });

  it('reports required fields, also when only spaces were typed', () => {
    const fields = [
      field({ key: 'name', type: 'string', required: true }),
      field({ key: 'kind', type: 'enum', enumValues: ['a', 'b'], required: true }),
      field({ key: 'age', type: 'integer', required: true }),
      field({ key: 'ok', type: 'boolean', required: true }),
    ];
    expect(issueCodes(fields, { name: '   ', kind: '', age: '', ok: false })).toEqual({
      name: 'required',
      kind: 'required',
      age: 'required',
    });
  });

  it('checks numbers: type, whole numbers and bounds (with the bound as parameter)', () => {
    const priority = FORM.fields[1];
    if (priority === undefined) throw new Error('sample changed');
    const check = (value: string) => checkElicitationDraft([priority], draftOf({ priority: value }));
    const issue = (value: string) => {
      const result = check(value);
      return result.ok ? null : result.issues.get('priority');
    };
    expect(issue('abc')).toEqual({ code: 'number', params: {} });
    expect(issue('2.5')).toEqual({ code: 'integer', params: {} });
    expect(issue('0')).toEqual({ code: 'minimum', params: { min: 1 } });
    expect(issue('9')).toEqual({ code: 'maximum', params: { max: 5 } });
    expect(check(' 4 ')).toMatchObject({ ok: true, response: { content: { priority: 4 } } });
    expect(check('')).toMatchObject({ ok: true, response: { content: {} } });
    const ratio = field({ key: 'ratio', type: 'number', minimum: 0, maximum: 1 });
    expect(checkElicitationDraft([ratio], draftOf({ ratio: '0.25' }))).toMatchObject({
      ok: true,
      response: { content: { ratio: 0.25 } },
    });
    expect(issueCodes([ratio], { ratio: 'Infinity' })).toEqual({ ratio: 'number' });
  });

  it('checks strings: length, email, uri and date like the server', () => {
    const fields = [
      field({ key: 'code', type: 'string', minLength: 3, maxLength: 5 }),
      field({ key: 'mail', type: 'string', format: 'email' }),
      field({ key: 'link', type: 'string', format: 'uri' }),
      field({ key: 'day', type: 'string', format: 'date' }),
    ];
    expect(issueCodes(fields, { code: 'ab', mail: 'nobody', link: 'example', day: '2026-13-01' })).toEqual({
      code: 'minLength',
      mail: 'email',
      link: 'uri',
      day: 'date',
    });
    expect(issueCodes(fields, { code: 'abcdef', mail: '', link: '', day: '' })).toEqual({
      code: 'maxLength',
    });
    expect(
      checkElicitationDraft(
        fields,
        draftOf({ code: 'abcd', mail: ' dev@mail.example ', link: 'https://a.example/x', day: '2026-11-21' }),
      ),
    ).toMatchObject({
      ok: true,
      response: {
        content: { code: 'abcd', mail: 'dev@mail.example', link: 'https://a.example/x', day: '2026-11-21' },
      },
    });
  });

  it('sends a plain string as typed (with its line breaks and spaces)', () => {
    const notes = field({ key: 'notes', type: 'string' });
    expect(checkElicitationDraft([notes], draftOf({ notes: ' line 1\nline 2 ' }))).toMatchObject({
      ok: true,
      response: { content: { notes: ' line 1\nline 2 ' } },
    });
  });

  it('turns a local date-time into RFC 3339 with the local offset and back', () => {
    const iso = localDateTimeToIso('2026-11-21T10:30');
    expect(iso).toMatch(/^2026-11-21T10:30:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(iso ?? '')).toBe(new Date(2026, 10, 21, 10, 30).getTime());
    expect(isoToLocalDateTime(iso ?? '')).toBe('2026-11-21T10:30');
    expect(localDateTimeToIso('2026-11-21T10:30:15')).toMatch(/T10:30:15[+-]/);
    expect(localDateTimeToIso('0099-01-02T03:04')).toMatch(/^0099-01-02T03:04:00/);
    expect(localDateTimeToIso('2026-02-30T10:00')).toBeNull();
    expect(localDateTimeToIso('2026-11-21T24:00')).toBeNull();
    expect(localDateTimeToIso('2026-11-21')).toBeNull();
    expect(isoToLocalDateTime('2026-11-21T08:00')).toBe('2026-11-21T08:00');
    expect(isoToLocalDateTime('not a date')).toBeNull();
    const when = field({ key: 'when', type: 'string', format: 'date-time', required: true });
    expect(checkElicitationDraft([when], draftOf({ when: '2026-11-21T10:30' }))).toEqual({
      ok: true,
      response: { action: 'accept', content: { when: iso } },
    });
    expect(issueCodes([when], { when: 'later' })).toEqual({ when: 'dateTime' });
  });

  it('a native date input the browser could not parse is an issue, not an empty field', () => {
    const day = field({ key: 'day', type: 'string', format: 'date' });
    const result = checkElicitationDraft([day], draftOf({ day: '' }), new Set(['day']));
    expect(result.ok ? null : result.issues.get('day')).toEqual({ code: 'date', params: {} });
  });

  it('an enum sends the value of the chosen index (values may repeat or be empty)', () => {
    const pick = field({ key: 'pick', type: 'enum', enumValues: ['', 'x', 'x'] });
    expect(checkElicitationDraft([pick], draftOf({ pick: '0' }))).toMatchObject({
      ok: true,
      response: { content: { pick: '' } },
    });
    expect(checkElicitationDraft([pick], draftOf({ pick: '2' }))).toMatchObject({
      response: { content: { pick: 'x' } },
    });
    expect(checkElicitationDraft([pick], draftOf({ pick: '' }))).toMatchObject({ response: { content: {} } });
  });

  it('a server-chosen key like __proto__ never changes the prototype of the content', () => {
    const odd = field({ key: '__proto__', type: 'string', required: true });
    const draft = new Map<string, ElicitationDraftValue>([['__proto__', 'value']]);
    expect(Object.fromEntries(initialElicitationDraft([odd]))).toEqual(
      Object.fromEntries([['__proto__', '']]),
    );
    const result = checkElicitationDraft([odd], draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.getPrototypeOf(result.response.content)).toBe(Object.prototype);
  });

  it('finds the field of a server refusal', () => {
    const refusal = makeError('DECISION_OPTION_UNAVAILABLE', { path: 'content.contact' });
    expect(fieldKeyOfError(refusal, FORM.fields)).toBe('contact');
    expect(
      fieldKeyOfError(makeError('DECISION_OPTION_UNAVAILABLE', { path: 'content' }), FORM.fields),
    ).toBeNull();
    expect(
      fieldKeyOfError(makeError('DECISION_OPTION_UNAVAILABLE', { path: 'content.x' }), FORM.fields),
    ).toBeNull();
    expect(fieldKeyOfError(makeError('ELICITATION_UNSUPPORTED', { reason: 'x' }), FORM.fields)).toBeNull();
  });

  it('hints: whole number, bounds and the length range', () => {
    expect(FORM.fields.map((f) => elicitationHints(f).map((hint) => t(hint.key, hint.params)))).toEqual([
      [],
      ['Whole number', 'From 1 to 5'],
      [],
      // maxLength alone: the input enforces it.
      [],
    ]);
    const code = field({ key: 'code', type: 'string', minLength: 3, maxLength: 5 });
    const pin = field({ key: 'pin', type: 'string', minLength: 4 });
    const amount = field({ key: 'amount', type: 'number', maximum: 10 });
    expect(
      [code, pin, amount].map((f) => elicitationHints(f).map((hint) => t(hint.key, hint.params))),
    ).toEqual([['3 to 5 characters'], ['At least 4 characters'], ['At most 10']]);
  });

  it('url target: only http(s), the host as parsed (punycode for look-alike names)', () => {
    expect(elicitationUrlTarget('https://sign-in.example/device')).toEqual({
      href: 'https://sign-in.example/device',
      host: 'sign-in.example',
    });
    expect(elicitationUrlTarget(null)).toBeNull();
    expect(elicitationUrlTarget('javascript:alert(1)')).toBeNull();
    expect(elicitationUrlTarget('file:///C:/secret.txt')).toBeNull();
    expect(elicitationUrlTarget('https://ex\u0430mple.example/')?.host).toMatch(/^xn--/);
  });

  it('names the server and the card', () => {
    const url = sampleDecisions.elicitationUrl();
    expect(elicitationServerText(FORM, t)).toBe('MCP server sample-tracker');
    expect(elicitationServerText(url, t)).toBe('MCP server Sample Auth (sample-auth)');
    expect(elicitationTitle(FORM, t)).toBe('New ticket');
    expect(elicitationTitle(url, t)).toBe('Input for Sample Auth');
  });
});
