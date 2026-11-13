/**
 * Step 2e of `pnpm cli-check` (WP-67 §1.4): the "Session info" requests in the probe session – after
 * the side-question step. Each read method (`getStatus`, `getMemoryDialog`, `getSkillsDialog`,
 * `getHooksListing`, `listPermissionRules`, `mcpServerStatus`, `exportConversation`) is called once
 * and its answer must parse with the server's parser (`backend/sessionInfo.ts` `sessionInfoOf`).
 * The actions (`reconnectMcpServer`, `toggleMcpServer`, `reloadSkills`, `reloadPlugins`) are only
 * checked for existence – never called. No model request, no cost.
 *
 * Privacy: the status rows hold account data (e-mail, organisation) and the memory rows the user's
 * paths – the result keeps only availability, a reason, the number of rows and the names of unknown
 * fields, never a value. The results go into the profile (`sessionInfo`, observation.ts); a change
 * against the profile is a finding (compare.ts). A failure here never stops the check.
 */
import { z } from 'zod';
import {
  SESSION_INFO_SECTIONS,
  sessionInfoSectionNameSchema,
  type SessionInfoSection,
  type SessionInfoSectionName,
} from '@shared/model';
import { withTimeout } from '../../src/server/backend/sdkBackend';
import {
  SESSION_INFO_METHODS,
  sessionInfoFailure,
  sessionInfoOf,
} from '../../src/server/backend/sessionInfo';
import type { CliProfile } from '../../src/server/claude/cliProfile';

/** The probe's Query: the read methods and the actions (all checked at runtime). */
export interface SessionInfoProbeHandle {
  getStatus?(): Promise<unknown>;
  getMemoryDialog?(): Promise<unknown>;
  getSkillsDialog?(): Promise<unknown>;
  getHooksListing?(): Promise<unknown>;
  listPermissionRules?(): Promise<unknown>;
  mcpServerStatus?(): Promise<unknown>;
  exportConversation?(): Promise<unknown>;
  reconnectMcpServer?(name: string): Promise<unknown>;
  toggleMcpServer?(name: string, enabled: boolean): Promise<unknown>;
  reloadSkills?(): Promise<unknown>;
  reloadPlugins?(): Promise<unknown>;
}

const sectionCheckSchema = z.object({
  section: sessionInfoSectionNameSchema,
  available: z.boolean(),
  /** Why not (English, for the report; the CLI's error text, never an answer); null when available. */
  detail: z.string().nullable(),
  /** Rows of the tab's main list (export: null) – a count, never a value. */
  rows: z.number().int().nonnegative().nullable(),
  /** Names of ignored fields (`<section>[.<list>]:<key>`), never values. */
  unknown: z.array(z.string()),
});
export type SessionInfoSectionCheck = z.infer<typeof sectionCheckSchema>;

export const sessionInfoProbeResultSchema = z.object({
  sections: z.array(sectionCheckSchema),
  /** `reconnectMcpServer` and `toggleMcpServer` exist (never called). */
  mcpActions: z.boolean(),
  /** `reloadSkills` and `reloadPlugins` exist (never called). */
  reload: z.boolean(),
});
export type SessionInfoProbeResult = z.infer<typeof sessionInfoProbeResultSchema>;

export interface SessionInfoProbeOptions {
  /** Time limit of each request (like the server's `infoMs`). */
  timeoutMs: number;
  log?: (line: string) => void;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
}

/** Rows of the main list of a tab (a count only). */
function rowsOf(data: SessionInfoSection): number | null {
  switch (data.section) {
    case 'status':
      return data.groups.length;
    case 'memory':
      return data.files.length;
    case 'skills':
      return data.skills.length;
    case 'hooks':
      return data.hooks.length;
    case 'permissions':
      return data.rules.length;
    case 'mcp':
      return data.servers.length;
    case 'export':
      return null;
  }
}

async function probeSection(
  handle: SessionInfoProbeHandle,
  section: SessionInfoSectionName,
  timeoutMs: number,
): Promise<SessionInfoSectionCheck> {
  const method = SESSION_INFO_METHODS[section];
  const missing = (detail: string): SessionInfoSectionCheck => ({
    section,
    available: false,
    detail,
    rows: null,
    unknown: [],
  });
  if (typeof handle[method] !== 'function') return missing(`Query.${method} is missing (SDK)`);
  let raw: unknown;
  try {
    raw = await withTimeout(handle[method](), timeoutMs, method);
  } catch (error) {
    const kind = sessionInfoFailure(error) === 'unavailable' ? 'refused' : 'failed';
    return missing(`${method} ${kind}: ${message(error)}`);
  }
  const parsed = sessionInfoOf(section, raw);
  if (parsed.data === null) {
    return {
      section,
      available: false,
      detail: `the answer of ${method} has an unknown shape`,
      rows: null,
      unknown: parsed.unknown,
    };
  }
  return { section, available: true, detail: null, rows: rowsOf(parsed.data), unknown: parsed.unknown };
}

/** Runs step 2e against the probe's Query (pure apart from the handle; tested with a fake handle). */
export async function probeSessionInfo(
  handle: SessionInfoProbeHandle,
  o: SessionInfoProbeOptions,
): Promise<SessionInfoProbeResult> {
  const log = o.log ?? (() => undefined);
  const sections: SessionInfoSectionCheck[] = [];
  // One after the other: the CLI answers control requests in order anyway.
  for (const section of SESSION_INFO_SECTIONS)
    sections.push(await probeSection(handle, section, o.timeoutMs));
  const mcpActions =
    typeof handle.reconnectMcpServer === 'function' && typeof handle.toggleMcpServer === 'function';
  const reload = typeof handle.reloadSkills === 'function' && typeof handle.reloadPlugins === 'function';
  const missing = sections.filter((s) => !s.available).map((s) => s.section);
  const unknown = sections.reduce((n, s) => n + s.unknown.length, 0);
  log(
    `cli-check: session info ${missing.length === 0 ? 'ok' : `NOT ok for ${missing.join(', ')}`} ` +
      `(${String(unknown)} unknown field(s)), MCP actions ${mcpActions ? 'present' : 'MISSING'}, ` +
      `reloads ${reload ? 'present' : 'MISSING'}`,
  );
  return { sections, mcpActions, reload };
}

/** The profile field of one probe result. */
export function sessionInfoProfile(result: SessionInfoProbeResult): NonNullable<CliProfile['sessionInfo']> {
  const available = (section: SessionInfoSectionName): boolean =>
    result.sections.find((s) => s.section === section)?.available ?? false;
  return {
    status: available('status'),
    memory: available('memory'),
    skills: available('skills'),
    hooks: available('hooks'),
    permissions: available('permissions'),
    mcp: available('mcp'),
    export: available('export'),
    mcpActions: result.mcpActions,
    reload: result.reload,
  };
}
