/**
 * WP-112 (ADR-256): MCP elicitation requests → the `elicitation` decision fields, and the check of a
 * form answer against those fields. Pure functions, used by the broker.
 *
 * The form subset Parallax renders (WP-110 §3.8): `requestedSchema` is an object schema whose
 * properties are `string` (with `enum`/`oneOf` titled values, the formats email/uri/date/date-time
 * and length bounds), `number`/`integer` (with bounds) or `boolean`, plus `required`, titles,
 * descriptions and defaults. Anything else (arrays/multi-select, nested objects, too many fields or
 * values, a non-http(s) URL) makes the request `unsupported` with an English reason – the card then
 * offers only "Decline". Unknown keywords of a supported field are dropped.
 */
import { z } from 'zod';
import { LIMITS } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  elicitationStringFormatSchema,
  isHttpUrl,
  type ElicitationField,
  type ElicitationMode,
  type ElicitationStringFormat,
  type ElicitationValue,
} from '@shared/model';
import type { ElicitationRequestInfo } from '../../backend/types';

/** `Decision.toolName` of every elicitation decision (no tool call belongs to it). */
export const ELICITATION_TOOL_NAME = 'Elicitation';

/** Text caps of the decision schema (`elicitationDecisionSchema`, `elicitationFieldSchema`). */
const CAP = {
  serverName: 200,
  elicitationId: 200,
  title: 500,
  displayName: 200,
  description: 2000,
  unsupported: 500,
  key: 200,
  fieldTitle: 500,
  fieldDescription: 2000,
  enumValue: 500,
} as const;

/** The decision fields built from one request (everything but the decision base). */
export interface NormalizedElicitation {
  serverName: string;
  message: string;
  mode: ElicitationMode;
  url: string | null;
  elicitationId: string | null;
  title: string | null;
  displayName: string | null;
  description: string | null;
  fields: ElicitationField[];
  unsupported: string | null;
}

/** Cuts `text` to at most `max` UTF-16 units without splitting a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function clipOrNull(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text === '' ? null : clip(text, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function lengthBound(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function formatOf(value: unknown): ElicitationStringFormat | null {
  const parsed = elicitationStringFormatSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A field could not be taken over: the reason (English, for the card). */
class Unsupported extends Error {}

function unsupported(reason: string): never {
  throw new Unsupported(reason);
}

interface EnumSpec {
  values: string[];
  names: string[] | null;
}

/** `enum` (+ legacy `enumNames`) or `oneOf: [{const, title}]` of a string field; null = neither. */
function enumOf(key: string, prop: Record<string, unknown>): EnumSpec | null {
  const raw = prop.enum;
  const oneOf = prop.oneOf ?? prop.anyOf;
  if (raw === undefined && oneOf === undefined) return null;
  let values: string[];
  let names: string[] | null = null;
  if (raw !== undefined) {
    if (!Array.isArray(raw) || !raw.every((v): v is string => typeof v === 'string')) {
      unsupported(`field "${key}": enum values must be strings`);
    }
    values = raw;
    const enumNames = prop.enumNames;
    if (
      Array.isArray(enumNames) &&
      enumNames.length === values.length &&
      enumNames.every((v): v is string => typeof v === 'string')
    ) {
      names = enumNames;
    }
  } else {
    if (!Array.isArray(oneOf)) unsupported(`field "${key}": oneOf must be a list`);
    values = [];
    const titles: string[] = [];
    for (const option of oneOf) {
      if (!isRecord(option) || typeof option.const !== 'string') {
        unsupported(`field "${key}": oneOf options need a string const`);
      }
      values.push(option.const);
      titles.push(typeof option.title === 'string' ? option.title : option.const);
    }
    names = titles;
  }
  if (values.length === 0) unsupported(`field "${key}": empty enum`);
  if (values.length > LIMITS.elicitationEnumMax) {
    unsupported(`field "${key}": more than ${String(LIMITS.elicitationEnumMax)} values`);
  }
  if (values.some((v) => v.length > CAP.enumValue)) unsupported(`field "${key}": enum value too long`);
  if (new Set(values).size !== values.length) unsupported(`field "${key}": duplicate enum values`);
  return { values, names: names === null ? null : names.map((n) => clip(n, CAP.enumValue)) };
}

function stringDefault(value: unknown): string | null {
  return typeof value === 'string' && value.length <= LIMITS.elicitationValueChars ? value : null;
}

function fieldOf(key: string, raw: unknown, required: boolean): ElicitationField {
  if (key.length === 0 || key.length > CAP.key) unsupported('a field name is empty or too long');
  if (!isRecord(raw)) unsupported(`field "${key}": not a schema object`);
  const base = {
    key,
    title: clipOrNull(stringOrNull(raw.title), CAP.fieldTitle),
    description: clipOrNull(stringOrNull(raw.description), CAP.fieldDescription),
    required,
    enumValues: null,
    enumNames: null,
    format: null,
    minimum: null,
    maximum: null,
    minLength: null,
    maxLength: null,
    default: null,
  } satisfies Omit<ElicitationField, 'type'>;
  const type = raw.type;
  switch (type) {
    case 'string': {
      const spec = enumOf(key, raw);
      if (spec !== null) {
        const fallback = stringDefault(raw.default);
        return {
          ...base,
          type: 'enum',
          enumValues: spec.values,
          enumNames: spec.names,
          default: fallback !== null && spec.values.includes(fallback) ? fallback : null,
        };
      }
      return {
        ...base,
        type: 'string',
        format: formatOf(raw.format),
        minLength: lengthBound(raw.minLength),
        maxLength: lengthBound(raw.maxLength),
        default: stringDefault(raw.default),
      };
    }
    case 'number':
    case 'integer': {
      const fallback = finiteOrNull(raw.default);
      return {
        ...base,
        type,
        minimum: finiteOrNull(raw.minimum),
        maximum: finiteOrNull(raw.maximum),
        default: fallback !== null && (type === 'number' || Number.isInteger(fallback)) ? fallback : null,
      };
    }
    case 'boolean':
      return { ...base, type: 'boolean', default: typeof raw.default === 'boolean' ? raw.default : null };
    default:
      return unsupported(
        typeof type === 'string'
          ? `field "${key}": type ${type} is not supported`
          : `field "${key}": no type`,
      );
  }
}

/** `requestedSchema` → fields; throws Unsupported. */
function fieldsOf(schema: Record<string, unknown> | null): ElicitationField[] {
  if (schema === null) return [];
  if (schema.type !== undefined && schema.type !== 'object') unsupported('the form is not an object schema');
  const properties = schema.properties;
  if (properties === undefined) return [];
  if (!isRecord(properties)) unsupported('the form has no field list');
  const keys = Object.keys(properties);
  if (keys.length > LIMITS.elicitationFieldsMax) {
    unsupported(`more than ${String(LIMITS.elicitationFieldsMax)} fields`);
  }
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [],
  );
  return keys.map((key) => fieldOf(key, properties[key], required.has(key)));
}

/** One SDK request → the fields of the `elicitation` decision (never throws). */
export function normalizeElicitation(req: ElicitationRequestInfo): NormalizedElicitation {
  const base: NormalizedElicitation = {
    serverName: clip(req.serverName === '' ? 'unknown' : req.serverName, CAP.serverName),
    message: clip(req.message, LIMITS.elicitationMessageChars),
    mode: req.mode,
    url: null,
    elicitationId:
      req.elicitationId !== null && req.elicitationId !== '' && req.elicitationId.length <= CAP.elicitationId
        ? req.elicitationId
        : null,
    title: clipOrNull(req.title, CAP.title),
    displayName: clipOrNull(req.displayName, CAP.displayName),
    description: clipOrNull(req.description, CAP.description),
    fields: [],
    unsupported: null,
  };
  if (req.mode === 'url') {
    if (req.url === null || req.url === '') return { ...base, unsupported: 'the request has no URL' };
    if (!isHttpUrl(req.url)) return { ...base, unsupported: 'the URL is not an http(s) link' };
    return { ...base, url: req.url };
  }
  try {
    return { ...base, fields: fieldsOf(req.requestedSchema) };
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    return { ...base, unsupported: clip(error.message, CAP.unsupported) };
  }
}

// ---- Answer check (accept in form mode) ----

function formatSchema(format: ElicitationStringFormat | null): z.ZodType<string, string> | null {
  switch (format) {
    case 'email':
      return z.email();
    case 'uri':
      return z.url();
    case 'date':
      return z.iso.date();
    case 'date-time':
      return z.iso.datetime({ offset: true });
    case null:
      return null;
  }
}

function fieldSchema(field: ElicitationField): z.ZodType<ElicitationValue> {
  switch (field.type) {
    case 'string': {
      let s = z
        .string()
        .max(Math.min(field.maxLength ?? LIMITS.elicitationValueChars, LIMITS.elicitationValueChars));
      if (field.minLength !== null) s = s.min(field.minLength);
      const format = formatSchema(field.format);
      return format === null ? s : s.pipe(format);
    }
    case 'enum': {
      const values = field.enumValues ?? [];
      return z.string().refine((v) => values.includes(v), { message: 'not one of the offered values' });
    }
    case 'number':
    case 'integer': {
      let n = field.type === 'integer' ? z.number().int() : z.number();
      if (field.minimum !== null) n = n.min(field.minimum);
      if (field.maximum !== null) n = n.max(field.maximum);
      return n;
    }
    case 'boolean':
      return z.boolean();
  }
}

/** The answer's `content` as the SDK gets it, or the error for `decision.respond`. */
export type ContentCheck =
  { ok: true; content: Record<string, ElicitationValue> } | { ok: false; error: ErrorPayload };

/**
 * Checks a form answer against the decision's fields (zod, built from the fields): only known keys,
 * every required field present, types, enum values, bounds, length and format. Error:
 * DECISION_OPTION_UNAVAILABLE {path: 'content.<key>'} (or `content` for a broken whole).
 */
export function checkElicitationContent(
  fields: readonly ElicitationField[],
  content: Readonly<Record<string, ElicitationValue>> | null,
): ContentCheck {
  const shape: Record<string, z.ZodType<ElicitationValue | undefined>> = {};
  for (const field of fields) {
    const schema = fieldSchema(field);
    shape[field.key] = field.required ? schema : schema.optional();
  }
  const parsed = z.strictObject(shape).safeParse(content ?? {});
  if (parsed.success) {
    const out: Record<string, ElicitationValue> = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) out[key] = value;
    }
    return { ok: true, content: out };
  }
  const issue = parsed.error.issues[0];
  let key: string | null = null;
  if (issue !== undefined) {
    const head = issue.path[0];
    if (typeof head === 'string') key = head;
    else if (issue.code === 'unrecognized_keys') key = issue.keys[0] ?? null;
  }
  const path = key === null ? 'content' : `content.${key}`;
  return {
    ok: false,
    error: makeError('DECISION_OPTION_UNAVAILABLE', { path }, issue?.message ?? 'invalid'),
  };
}
