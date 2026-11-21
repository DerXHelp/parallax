import { useCallback, useEffect, useState } from 'react';
import { parseSessionKey, type EntryId } from '@shared/common';
import { errorPayloadSchema, makeError, type ErrorPayload } from '@shared/errors';
import type { PlanAnnotation, PlanVersionInfo } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { sessionFileUrl } from '@web/lib/host-urls';
import { SizedLru } from '@web/lib/sized-cache';
import { errorPayloadOf } from '@web/state/connection';
import { useSessionPaths } from '@web/state/host-platform';
import { sendCommand, useSessionSelector } from '@web/state/hooks';
import { planFileActivity, type PlanFileActivity, type PlanFileRule } from '../lib/plan-file';

/**
 * Data of the plan tab (WP-56, ADR-148): the stored versions (`plan.list`), their texts
 * (`plan.read`, immutable per entry and version – cached), the plan file's content
 * (`GET /api/file`, again after every finished write on it) and the plan file calls of the
 * transcript. Answers arrive asynchronously (never a synchronous setState in an effect); an answer
 * for an older request is dropped.
 */

export interface TextState {
  text: string | null;
  error: ErrorPayload | null;
  /** A request for the current key is under way (`text` may still be the previous one). */
  loading: boolean;
}

const NO_ACTIVITY: PlanFileActivity = { liveItemId: null, path: null, writtenAt: null };

/** Plan file calls of the session's transcript (re-renders only when one of the values changes). */
export function usePlanFileActivity(sessionKey: string, rule: PlanFileRule): PlanFileActivity {
  const { planPath, planMode } = rule;
  const rules = useSessionPaths(sessionKey);
  const select = useCallback(
    (view: SessionViewState) => planFileActivity(view.items, { planPath, planMode, rules }),
    [planPath, planMode, rules],
  );
  return useSessionSelector(sessionKey, select, NO_ACTIVITY);
}

// ---- plan.list ----

export interface PlanVersionsState {
  versions: readonly PlanVersionInfo[] | null;
  error: ErrorPayload | null;
  loading: boolean;
}

interface ListResult {
  sessionKey: string;
  key: string;
  versions: readonly PlanVersionInfo[] | null;
  error: ErrorPayload | null;
}

/** `plan.list` of the session, again whenever `refreshKey` changes (new version, a decision closed). */
export function usePlanVersions(sessionKey: string, refreshKey: string): PlanVersionsState {
  const key = `${sessionKey}|${refreshKey}`;
  const [result, setResult] = useState<ListResult | null>(null);
  useEffect(() => {
    const parsed = parseSessionKey(sessionKey);
    if (parsed === null) return undefined;
    let current = true;
    sendCommand(sessionKey, { name: 'plan.list', entryId: parsed.entryId }).then(
      ({ versions }) => {
        if (current) setResult({ sessionKey, key, versions, error: null });
      },
      (caught: unknown) => {
        if (current) setResult({ sessionKey, key, versions: null, error: errorPayloadOf(caught) });
      },
    );
    return () => {
      current = false;
    };
  }, [key, sessionKey]);
  // The previous answer of the same session stays visible while the next one loads.
  if (result?.sessionKey !== sessionKey) return { versions: null, error: null, loading: true };
  return { versions: result.versions, error: result.error, loading: result.key !== key };
}

// ---- plan.read ----

/** Texts of stored versions (≤ 60 entries, ≈ 4 Mi chars; a version's text never changes). */
const planTexts = new SizedLru<string, string>({ maxEntries: 60, maxSize: 4 * 1024 * 1024 });
/**
 * WP-93: annotations kept with a version (`plan.read`; ≤ 60 versions). Read together with the text,
 * never again for an answered version (they no longer change).
 */
const planNotes = new SizedLru<string, readonly PlanAnnotation[]>({ maxEntries: 60, maxSize: 60 });
const planReads = new Map<string, Promise<string>>();

function textKey(sessionKey: string, version: number): string {
  return `${sessionKey}|${String(version)}`;
}

function readPlanText(sessionKey: string, version: number): Promise<string> {
  const key = textKey(sessionKey, version);
  const running = planReads.get(key);
  if (running !== undefined) return running;
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return Promise.reject(new Error('invalid session key'));
  const request = sendCommand(sessionKey, { name: 'plan.read', entryId: parsed.entryId, version }).then(
    ({ text, annotations }) => {
      planTexts.set(key, text, text.length);
      planNotes.set(key, annotations, 1);
      return text;
    },
  );
  planReads.set(key, request);
  const forget = () => {
    planReads.delete(key);
  };
  request.then(forget, forget);
  return request;
}

interface ReadResult {
  key: string;
  text: string | null;
  error: ErrorPayload | null;
}

/**
 * Text of `version` (null = none): `known` when the client already has it (open decision, copy),
 * else the cache, else `plan.read` (PLAN_NOT_FOUND when `plans/v<N>.md` is missing).
 */
export function usePlanText(sessionKey: string, version: number | null, known: string | null): TextState {
  const key = version === null ? null : textKey(sessionKey, version);
  const cached = key === null ? undefined : planTexts.peek(key);
  const [result, setResult] = useState<ReadResult | null>(null);
  const needed = key !== null && known === null && cached === undefined;
  useEffect(() => {
    if (!needed || version === null) return undefined;
    let current = true;
    readPlanText(sessionKey, version).then(
      (text) => {
        if (current) setResult({ key, text, error: null });
      },
      (caught: unknown) => {
        if (current) setResult({ key, text: null, error: errorPayloadOf(caught) });
      },
    );
    return () => {
      current = false;
    };
  }, [key, needed, sessionKey, version]);
  if (key === null) return { text: null, error: null, loading: false };
  if (known !== null) return { text: known, error: null, loading: false };
  if (cached !== undefined) return { text: cached, error: null, loading: false };
  if (result?.key === key) return { text: result.text, error: result.error, loading: false };
  return { text: null, error: null, loading: true };
}

interface NotesResult {
  key: string;
  annotations: readonly PlanAnnotation[] | null;
}

const NO_NOTES: readonly PlanAnnotation[] = [];

/**
 * WP-93: the annotations kept with `version` (null = none to load) – from the cache, else via
 * `plan.read` (also when the text is known already). A failed read counts as none.
 */
export function usePlanVersionAnnotations(
  sessionKey: string,
  version: number | null,
): readonly PlanAnnotation[] | null {
  const key = version === null ? null : textKey(sessionKey, version);
  const cached = key === null ? undefined : planNotes.peek(key);
  const [result, setResult] = useState<NotesResult | null>(null);
  const needed = key !== null && cached === undefined;
  useEffect(() => {
    if (!needed || version === null) return undefined;
    let current = true;
    readPlanText(sessionKey, version).then(
      () => {
        if (current) setResult({ key, annotations: planNotes.peek(key) ?? NO_NOTES });
      },
      () => {
        if (current) setResult({ key, annotations: NO_NOTES });
      },
    );
    return () => {
      current = false;
    };
  }, [key, needed, sessionKey, version]);
  if (key === null) return null;
  if (cached !== undefined) return cached;
  return result?.key === key ? result.annotations : null;
}

// ---- the plan file (GET /api/file) ----

export interface PlanFileTarget {
  sessionKey: string;
  entryId: EntryId;
  path: string;
}

/** Reads the plan file's text; rejects with a PlanFileError. */
export type PlanFileReader = (file: PlanFileTarget, signal: AbortSignal) => Promise<string>;

export class PlanFileError extends Error {
  readonly error: ErrorPayload;
  constructor(error: ErrorPayload) {
    super(error.message ?? error.code);
    this.name = 'PlanFileError';
    this.error = error;
  }
}

async function errorOf(response: Response): Promise<ErrorPayload> {
  try {
    const parsed = errorPayloadSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data;
  } catch {
    // Not a JSON error body.
  }
  return makeError(response.status === 404 ? 'FILE_NOT_FOUND' : 'INTERNAL_ERROR', {
    status: response.status,
  });
}

/**
 * The real reader: `GET /api/file?entryId&path` of this origin (cookie, Sec-Fetch-Site same-origin);
 * WP-80: for another computer's session its forwarding route (`sessionFileUrl`).
 */
export const httpPlanFileReader: PlanFileReader = async (file, signal) => {
  let response: Response;
  try {
    response = await fetch(sessionFileUrl(file.sessionKey, file.entryId, file.path), {
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new PlanFileError(makeError('CONNECTION_LOST'));
  }
  if (!response.ok) throw new PlanFileError(await errorOf(response));
  return response.text();
};

let reader: PlanFileReader = httpPlanFileReader;

/** Replaces the reader (playground, tests – there is no `/api/file` there); null restores HTTP. */
export function setPlanFileReader(next: PlanFileReader | null): void {
  reader = next ?? httpPlanFileReader;
}

interface FileResult {
  sessionKey: string;
  path: string;
  key: string;
  text: string | null;
  error: ErrorPayload | null;
}

/**
 * Text of the plan file `path`, loaded again whenever `stamp` changes (a finished write on it).
 * `enabled: false` loads nothing (live preview, another version shown). While a reload runs the
 * previous text of the same file stays.
 */
export function usePlanFileText(
  sessionKey: string,
  path: string | null,
  stamp: string,
  enabled: boolean,
): TextState {
  const key = `${sessionKey}|${path ?? ''}|${stamp}`;
  const [result, setResult] = useState<FileResult | null>(null);
  useEffect(() => {
    if (!enabled || path === null) return undefined;
    const parsed = parseSessionKey(sessionKey);
    if (parsed === null) return undefined;
    const controller = new AbortController();
    reader({ sessionKey, entryId: parsed.entryId, path }, controller.signal).then(
      (text) => {
        if (!controller.signal.aborted) setResult({ sessionKey, path, key, text, error: null });
      },
      (caught: unknown) => {
        if (controller.signal.aborted) return;
        const error = caught instanceof PlanFileError ? caught.error : makeError('INTERNAL_ERROR');
        setResult({ sessionKey, path, key, text: null, error });
      },
    );
    return () => {
      controller.abort();
    };
  }, [enabled, key, path, sessionKey]);
  if (path === null) return { text: null, error: null, loading: false };
  if (result?.sessionKey !== sessionKey || result.path !== path) {
    return { text: null, error: null, loading: enabled };
  }
  return { text: result.text, error: result.error, loading: enabled && result.key !== key };
}

/** Tests: forget cached plan texts. */
export function resetPlanData(): void {
  planTexts.clear();
  planNotes.clear();
  planReads.clear();
  reader = httpPlanFileReader;
}
