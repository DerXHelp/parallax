import { z } from 'zod';
import { LIMITS } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  elicitationResponseSchema,
  isHttpUrl,
  type ElicitationDecision,
  type ElicitationField,
  type ElicitationResponse,
  type ElicitationStringFormat,
  type ElicitationValue,
} from '@shared/model';
import type { t as translateFn, TranslationKey, TranslationParams } from '@web/i18n';

/**
 * Pure helpers of the elicitation card (WP-116, ADR-256): which control a field gets, the draft the
 * card holds, the zod check of that draft built from the fields (the same rules the server checks
 * in `checkElicitationContent`, with codes the card translates), hints, the url target and the
 * names of the asking MCP server. Field keys come from an MCP server: drafts and issues are Maps and
 * the answer's `content` is built with `Object.fromEntries` (a key `__proto__` stays a plain key).
 */

/** Enum fields with at most this many values are radio buttons; more → a select. */
export const ELICITATION_RADIO_MAX = 5;

/** Plain strings with a `maxLength` up to this are one line; longer or unbounded → multi-line. */
export const ELICITATION_SINGLE_LINE_MAX = 200;

export type ElicitationControl =
  'text' | 'multiline' | 'email' | 'url' | 'date' | 'datetime' | 'number' | 'checkbox' | 'radio' | 'select';

export function elicitationControl(field: ElicitationField): ElicitationControl {
  switch (field.type) {
    case 'boolean':
      return 'checkbox';
    case 'number':
    case 'integer':
      return 'number';
    case 'enum':
      return (field.enumValues ?? []).length <= ELICITATION_RADIO_MAX ? 'radio' : 'select';
    case 'string':
      switch (field.format) {
        case 'email':
          return 'email';
        case 'uri':
          return 'url';
        case 'date':
          return 'date';
        case 'date-time':
          return 'datetime';
        case null:
          return field.maxLength !== null && field.maxLength <= ELICITATION_SINGLE_LINE_MAX
            ? 'text'
            : 'multiline';
      }
  }
}

/** Longest string the answer may carry for this field (its `maxLength`, capped by the contract). */
export function maxLengthOf(field: ElicitationField): number {
  return Math.min(field.maxLength ?? LIMITS.elicitationValueChars, LIMITS.elicitationValueChars);
}

// ---- draft ----

/**
 * What the card holds per field: the text of an input (a number as typed, a date-time as the
 * `datetime-local` value), the index of the chosen enum value ('' = none) or a checkbox state.
 */
export type ElicitationDraftValue = string | boolean;
export type ElicitationDraft = ReadonlyMap<string, ElicitationDraftValue>;

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function localDateTimeText(date: Date): string {
  const base = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getSeconds() === 0 ? base : `${base}:${pad(date.getSeconds())}`;
}

/**
 * A `datetime-local` value (`2026-11-21T10:30`, seconds optional) as an RFC 3339 date-time with the
 * local offset (`2026-11-21T10:30:00+01:00`) – what `format: date-time` asks for. null = not a
 * local date-time.
 */
export function localDateTimeToIso(value: string): string | null {
  const match = LOCAL_DATE_TIME.exec(value);
  if (match === null) return null;
  const part = (index: number) => Number(match[index] ?? 0);
  const [year, month, day, hour, minute, second] = [part(1), part(2), part(3), part(4), part(5), part(6)];
  if (hour > 23 || minute > 59 || second > 59) return null;
  // new Date(y, …) maps years below 100 to 19xx; setFullYear does not.
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  if (Number.isNaN(date.getTime()) || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** An RFC 3339 date-time (or a local one) as a `datetime-local` value; null = not a date-time. */
export function isoToLocalDateTime(value: string): string | null {
  if (LOCAL_DATE_TIME.test(value)) return value;
  if (!z.iso.datetime({ offset: true }).safeParse(value).success) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : localDateTimeText(date);
}

function initialValue(field: ElicitationField): ElicitationDraftValue {
  const value = field.default;
  switch (field.type) {
    case 'boolean':
      return value === true;
    case 'enum': {
      const index = typeof value === 'string' ? (field.enumValues ?? []).indexOf(value) : -1;
      return index < 0 ? '' : String(index);
    }
    case 'number':
    case 'integer':
      return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
    case 'string': {
      if (typeof value !== 'string') return '';
      if (field.format === 'date-time') return isoToLocalDateTime(value) ?? '';
      if (field.format === 'date') return z.iso.date().safeParse(value).success ? value : '';
      return value.slice(0, maxLengthOf(field));
    }
  }
}

/** The draft of a new card: every field with its `default` (or empty / unchecked). */
export function initialElicitationDraft(fields: readonly ElicitationField[]): ElicitationDraft {
  return new Map(fields.map((field) => [field.key, initialValue(field)]));
}

// ---- check ----

/** Why a field cannot be sent; `rejected` = the server refused the value (never from the check). */
export const ELICITATION_ISSUES = [
  'required',
  'email',
  'uri',
  'date',
  'dateTime',
  'number',
  'integer',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'enum',
  'rejected',
] as const;
export type ElicitationIssueCode = (typeof ELICITATION_ISSUES)[number];

export interface ElicitationIssue {
  code: ElicitationIssueCode;
  params: TranslationParams;
}

const ISSUE_CODES: ReadonlySet<string> = new Set(ELICITATION_ISSUES);

function isIssueCode(value: string | undefined): value is ElicitationIssueCode {
  return value !== undefined && ISSUE_CODES.has(value);
}

const FORMAT_ISSUE = {
  email: 'email',
  uri: 'uri',
  date: 'date',
  'date-time': 'dateTime',
} as const satisfies Record<ElicitationStringFormat, ElicitationIssueCode>;

function formatSchema(format: ElicitationStringFormat | null): z.ZodType<string, string> | null {
  switch (format) {
    case 'email':
      return z.email(FORMAT_ISSUE.email);
    case 'uri':
      return z.url(FORMAT_ISSUE.uri);
    case 'date':
      return z.iso.date(FORMAT_ISSUE.date);
    case 'date-time':
      return z.iso.datetime({ offset: true, error: FORMAT_ISSUE['date-time'] });
    case null:
      return null;
  }
}

/** The zod schema of one present value; issue messages are ElicitationIssueCodes. */
function fieldSchema(field: ElicitationField): z.ZodType<ElicitationValue> {
  switch (field.type) {
    case 'string': {
      let schema = z.string().max(maxLengthOf(field), 'maxLength');
      if (field.minLength !== null) schema = schema.min(field.minLength, 'minLength');
      const format = formatSchema(field.format);
      return format === null ? schema : schema.pipe(format);
    }
    case 'enum': {
      const values = field.enumValues ?? [];
      return z.string().refine((value) => values.includes(value), 'enum');
    }
    case 'number':
    case 'integer': {
      let schema = z.number('number');
      if (field.type === 'integer') schema = schema.int('integer');
      if (field.minimum !== null) schema = schema.min(field.minimum, 'minimum');
      if (field.maximum !== null) schema = schema.max(field.maximum, 'maximum');
      return schema;
    }
    case 'boolean':
      return z.boolean();
  }
}

function fallbackCode(field: ElicitationField): ElicitationIssueCode {
  switch (field.type) {
    case 'string':
      return field.format === null ? 'maxLength' : FORMAT_ISSUE[field.format];
    case 'enum':
      return 'enum';
    case 'integer':
      return 'integer';
    case 'number':
    case 'boolean':
      return 'number';
  }
}

function issueOf(field: ElicitationField, code: ElicitationIssueCode): ElicitationIssue {
  switch (code) {
    case 'minimum':
      return { code, params: { min: field.minimum ?? 0 } };
    case 'maximum':
      return { code, params: { max: field.maximum ?? 0 } };
    case 'minLength':
      return { code, params: { min: field.minLength ?? 0 } };
    case 'maxLength':
      return { code, params: { max: maxLengthOf(field) } };
    default:
      return { code, params: {} };
  }
}

/** The value of a draft entry as the answer carries it; undefined = empty (left out). */
function draftValue(
  field: ElicitationField,
  raw: ElicitationDraftValue | undefined,
): ElicitationValue | undefined {
  if (field.type === 'boolean') return raw === true;
  const text = typeof raw === 'string' ? raw : '';
  if (text.trim() === '') return undefined;
  switch (field.type) {
    case 'enum':
      return (field.enumValues ?? [])[Number(text)];
    case 'number':
    case 'integer':
      return Number(text.trim());
    case 'string':
      if (field.format === 'date-time') return localDateTimeToIso(text.trim()) ?? text;
      return field.format === null ? text : text.trim();
  }
}

export type ElicitationCheck =
  | { ok: true; response: ElicitationResponse }
  | {
      ok: false;
      /** Per field key, in field order. */
      issues: ReadonlyMap<string, ElicitationIssue>;
      /** The answer as a whole does not fit the contract (never expected; shown in the card). */
      error: ErrorPayload | null;
    };

/**
 * Checks the draft with zod built from the fields (required, types, enum values, bounds, length,
 * format) and builds the `accept` answer. `badInput`: keys whose native date input holds a value
 * the browser could not parse (its `value` is then '').
 */
export function checkElicitationDraft(
  fields: readonly ElicitationField[],
  draft: ElicitationDraft,
  badInput: ReadonlySet<string> = new Set(),
): ElicitationCheck {
  const issues = new Map<string, ElicitationIssue>();
  const entries: [string, ElicitationValue][] = [];
  for (const field of fields) {
    if (badInput.has(field.key)) {
      issues.set(field.key, issueOf(field, fallbackCode(field)));
      continue;
    }
    const value = draftValue(field, draft.get(field.key));
    if (value === undefined) {
      if (field.required) issues.set(field.key, issueOf(field, 'required'));
      continue;
    }
    const parsed = fieldSchema(field).safeParse(value);
    if (parsed.success) {
      entries.push([field.key, parsed.data]);
      continue;
    }
    const message = parsed.error.issues[0]?.message;
    issues.set(field.key, issueOf(field, isIssueCode(message) ? message : fallbackCode(field)));
  }
  if (issues.size > 0) return { ok: false, issues, error: null };
  const response = elicitationResponseSchema.safeParse({
    action: 'accept',
    content: Object.fromEntries(entries),
  });
  if (!response.success) {
    return { ok: false, issues, error: makeError('VALIDATION_FAILED', { path: 'content' }) };
  }
  return { ok: true, response: response.data };
}

/** The field a server error points at (`DECISION_OPTION_UNAVAILABLE {path: 'content.<key>'}`). */
export function fieldKeyOfError(error: ErrorPayload, fields: readonly ElicitationField[]): string | null {
  const path = error.params.path;
  if (typeof path !== 'string' || !path.startsWith('content.')) return null;
  const key = path.slice('content.'.length);
  return fields.some((field) => field.key === key) ? key : null;
}

// ---- hints ----

export interface ElicitationHint {
  key: TranslationKey;
  params?: TranslationParams;
}

/** Hints under a field: whole number, bounds, the length range (an input enforces `maxLength` itself). */
export function elicitationHints(field: ElicitationField): ElicitationHint[] {
  const hints: ElicitationHint[] = [];
  if (field.type === 'integer') hints.push({ key: 'decisions.elicitation.hints.integer' });
  if (field.type === 'number' || field.type === 'integer') {
    const { minimum: min, maximum: max } = field;
    if (min !== null && max !== null)
      hints.push({ key: 'decisions.elicitation.hints.range', params: { min, max } });
    else if (min !== null) hints.push({ key: 'decisions.elicitation.hints.atLeast', params: { min } });
    else if (max !== null) hints.push({ key: 'decisions.elicitation.hints.atMost', params: { max } });
  }
  if (field.type === 'string' && field.minLength !== null) {
    hints.push(
      field.maxLength === null
        ? { key: 'decisions.elicitation.hints.minLength', params: { min: field.minLength } }
        : {
            key: 'decisions.elicitation.hints.length',
            params: { min: field.minLength, max: maxLengthOf(field) },
          },
    );
  }
  return hints;
}

// ---- url mode, names ----

export interface ElicitationUrlTarget {
  href: string;
  /** Host as the URL parser sees it (an internationalized name in punycode – no look-alikes). */
  host: string;
}

/** The url mode's target; null = none or not http(s) (the card then offers only "Decline"). */
export function elicitationUrlTarget(url: string | null): ElicitationUrlTarget | null {
  if (url === null || !isHttpUrl(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.host === '' ? null : { href: url, host: parsed.host };
  } catch {
    return null;
  }
}

/** Name of the asking server for texts: its display name, else the configured name. */
export function elicitationServerName(decision: ElicitationDecision): string {
  return decision.displayName ?? decision.serverName;
}

/** "MCP server <name>" (with the configured name when the display name differs). */
export function elicitationServerText(decision: ElicitationDecision, t: typeof translateFn): string {
  const { displayName, serverName } = decision;
  return displayName === null || displayName === serverName
    ? t('decisions.elicitation.server', { name: serverName })
    : t('decisions.elicitation.serverNamed', { name: displayName, server: serverName });
}

/** Title of the card: the request's own title, else "Input for <server>". */
export function elicitationTitle(decision: ElicitationDecision, t: typeof translateFn): string {
  return decision.title ?? t('decisions.elicitation.title', { server: elicitationServerName(decision) });
}
