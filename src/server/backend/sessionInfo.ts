/**
 * WP-67: the SDK boundary of "Session info" – the answers of the CLI's dialog requests (claude
 * 2.1.322/323, derived from the bundled CLI code, docs/wp/WP-67.md §3):
 *
 * | section | SDK method (0.3.322) | raw answer |
 * |---|---|---|
 * | status | `getStatus()` (internal) | `{sections: [{title, rows: [{label?, value}]}]}` |
 * | memory | `getMemoryDialog()` (internal) | `{files, folders, memories?, auto_memory, auto_dream}` |
 * | skills | `getSkillsDialog()` (internal) | `{skills: [{name, display_name, description, source, tokens, state, locked_by?, …}]}` |
 * | hooks | `getHooksListing()` (internal) | `{events, hooks, eventCatalog, policy, safeMode?, bareMode?, errors?}` |
 * | permissions | `listPermissionRules()` (internal) | `{state: {rules, workspaceDirectories, originalCwd, managedOnly, errors?}}` |
 * | mcp | `mcpServerStatus()` (typed) | `McpServerStatus[]` (the SDK unwraps `mcpServers`) |
 * | export | `exportConversation()` (internal) | `{text, default_filename}` |
 *
 * Pure helpers: tolerant parsing (zod) into the display forms of `@shared/model` (5.15). Only the
 * core of an answer is required (the list a tab shows); a row that does not parse is dropped, every
 * other field falls back to a default. Unknown fields are ignored and reported as keys (`unknown`,
 * never values – the status rows hold account data); unknown scalar top-level fields become generic
 * "label: value" rows (`extra`). Lists and texts are cut to SESSION_INFO_LIMITS. Used by SdkBackend,
 * the FakeBackend (its fake answers take the same path) and the cli-check probe.
 */
import { z } from 'zod';
import {
  SESSION_INFO_LIMITS,
  sessionInfoSectionSchema,
  type InfoRow,
  type InfoSettingsError,
  type MemoryFileKind,
  type SessionInfoOf,
  type SessionInfoSection,
  type SessionInfoSectionName,
} from '@shared/model';
import { toError } from '../lib/async';

/** The normalized tab (null = the answer has an unknown shape) and the unknown keys it carried. */
export interface ParsedSessionInfo {
  data: SessionInfoSection | null;
  /** `<section>[.<list>]:<key>` of ignored fields, `<section>.<list>:invalid` of dropped rows (sorted). */
  unknown: string[];
}

const { listMax, textChars, exportChars, fileNameChars } = SESSION_INFO_LIMITS;

/** A text cut to `max` characters. */
export function clip(text: string, max: number = textChars): string {
  return text.length > max ? text.slice(0, max) : text;
}

const optText = z.string().optional().catch(undefined);
const optBool = z.boolean().optional().catch(undefined);
const optNumber = z.number().optional().catch(undefined);

/** Collects the unknown keys of one parse. */
class Unknown {
  private readonly keys = new Set<string>();

  add(key: string): void {
    this.keys.add(key);
  }

  /** Keys of `raw` that are not in `known` (only for plain objects). */
  extraKeys(raw: unknown, known: ReadonlySet<string>, path: string): string[] {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
    const extra = Object.keys(raw).filter((key) => !known.has(key));
    for (const key of extra) this.add(`${path}:${key}`);
    return extra;
  }

  list(): string[] {
    return [...this.keys].sort();
  }
}

/** Own property of a plain object, without type assertions. */
function field(raw: unknown, key: string): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Object.hasOwn(raw, key))
    return undefined;
  const value: unknown = Reflect.get(raw, key);
  return value;
}

/** Shape keys of a zod object schema (the "known" fields). */
function keysOf(schema: z.ZodObject): ReadonlySet<string> {
  return new Set(Object.keys(schema.shape));
}

/**
 * Rows of a raw list: each item parsed alone (a bad row is dropped and counted), unknown keys of
 * each row counted, at most `listMax` rows (`truncated`).
 */
function rowsOf<S extends z.ZodObject, T>(
  raw: unknown,
  schema: S,
  map: (row: z.infer<S>) => T | null,
  path: string,
  unknown: Unknown,
): { rows: T[]; truncated: boolean } {
  if (!Array.isArray(raw)) return { rows: [], truncated: false };
  const known = keysOf(schema);
  const rows: T[] = [];
  let truncated = false;
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    const row = parsed.success ? map(parsed.data) : null;
    if (row === null) {
      unknown.add(`${path}:invalid`);
      continue;
    }
    unknown.extraKeys(item, known, path);
    if (rows.length >= listMax) {
      truncated = true;
      break;
    }
    rows.push(row);
  }
  return { rows, truncated };
}

/**
 * Unknown top-level fields: scalars become generic rows, objects/arrays are only counted. `null`
 * and `undefined` values are skipped.
 */
function extraRows(raw: unknown, known: ReadonlySet<string>, section: string, unknown: Unknown): InfoRow[] {
  const rows: InfoRow[] = [];
  for (const key of unknown.extraKeys(raw, known, section)) {
    const value = field(raw, key);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (rows.length < listMax) rows.push({ label: clip(key), value: clip(String(value)) });
    }
  }
  return rows;
}

const settingsErrorSchema = z.looseObject({ file: optText, path: z.string().catch(''), message: z.string() });

function settingsErrors(raw: unknown, path: string, unknown: Unknown): InfoSettingsError[] {
  return rowsOf(
    raw,
    settingsErrorSchema,
    (e) => ({
      file: e.file === undefined ? null : clip(e.file),
      path: clip(e.path),
      message: clip(e.message),
    }),
    path,
    unknown,
  ).rows;
}

// ---- status ----

const statusRowSchema = z.looseObject({ label: optText, value: z.unknown() });
const statusGroupSchema = z.looseObject({
  title: z.string().catch(''),
  rows: z.array(z.unknown()).catch([]),
});
const statusSchema = z.looseObject({ sections: z.array(z.unknown()) });

/** A status value as text (the CLI already renders them; a number/boolean of a newer CLI is taken too). */
function valueText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function statusOf(raw: unknown, unknown: Unknown): SessionInfoOf<'status'> | null {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) return null;
  const groups = rowsOf(
    parsed.data.sections,
    statusGroupSchema,
    (group) => ({
      title: clip(group.title),
      rows: rowsOf(
        group.rows,
        statusRowSchema,
        (row) => {
          const value = valueText(row.value);
          if (value === null) return null;
          const label = row.label?.trim() ?? '';
          return { label: label === '' ? null : clip(label), value: clip(value) };
        },
        'status.rows',
        unknown,
      ).rows,
    }),
    'status.sections',
    unknown,
  ).rows;
  return { section: 'status', groups, extra: extraRows(raw, keysOf(statusSchema), 'status', unknown) };
}

// ---- memory ----

const MEMORY_KINDS: ReadonlySet<string> = new Set<MemoryFileKind>([
  'user',
  'project',
  'project-alt',
  'local',
  'other',
]);

function memoryKind(kind: string | undefined): MemoryFileKind {
  switch (kind) {
    case 'user':
    case 'project':
    case 'project-alt':
    case 'local':
      return kind;
    default:
      return 'other';
  }
}

const memoryFileSchema = z.looseObject({
  kind: optText,
  path: z.string().min(1),
  label: optText,
  description: optText,
  exists: optBool,
});
const memoryFolderSchema = z.looseObject({
  kind: optText,
  path: z.string().min(1),
  label: optText,
  description: optText,
});
const memorySchema = z.looseObject({
  files: z.array(z.unknown()),
  folders: z.array(z.unknown()).optional().catch(undefined),
  memories: z.array(z.unknown()).optional().catch(undefined),
  auto_memory: z
    .looseObject({ enabled: optBool, toggleable: optBool, status: optText })
    .optional()
    .catch(undefined),
  auto_dream: z
    .looseObject({ shown: optBool, enabled: optBool, toggleable: optBool, status: optText, detail: optText })
    .optional()
    .catch(undefined),
});
const memoryEntrySchema = z.looseObject({
  name: optText,
  path: z.string().min(1),
  description: z.string().nullish().catch(null),
  type: z.string().nullish().catch(null),
  modified_ms: optNumber,
});

/** Epoch milliseconds → ISO time (null when not a usable instant). */
function isoOf(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function memoryOf(raw: unknown, unknown: Unknown): SessionInfoOf<'memory'> | null {
  const parsed = memorySchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const files = rowsOf(
    m.files,
    memoryFileSchema,
    (f) => {
      // A kind of a newer CLI shows as "other" (counted, the value is a fixed word of the CLI).
      if (f.kind !== undefined && !MEMORY_KINDS.has(f.kind))
        unknown.add(`memory.files.kind:${clip(f.kind, 40)}`);
      return {
        kind: memoryKind(f.kind),
        path: clip(f.path),
        label: clip(f.label ?? f.path),
        description: clip(f.description ?? ''),
        exists: f.exists ?? true,
      };
    },
    'memory.files',
    unknown,
  );
  const folders = rowsOf(
    m.folders,
    memoryFolderSchema,
    (f) => ({
      kind: clip(f.kind ?? ''),
      path: clip(f.path),
      label: clip(f.label ?? f.path),
      description: clip(f.description ?? ''),
    }),
    'memory.folders',
    unknown,
  );
  const memories = rowsOf(
    m.memories,
    memoryEntrySchema,
    (e) => ({
      name: clip(e.name ?? e.path),
      path: clip(e.path),
      description: e.description === null || e.description === undefined ? null : clip(e.description),
      type: e.type === null || e.type === undefined ? null : clip(e.type),
      modifiedAt: isoOf(e.modified_ms),
    }),
    'memory.memories',
    unknown,
  );
  const auto = m.auto_memory;
  const dream = m.auto_dream;
  return {
    section: 'memory',
    files: files.rows,
    folders: folders.rows,
    memories: memories.rows,
    autoMemory:
      auto === undefined
        ? null
        : {
            enabled: auto.enabled ?? false,
            toggleable: auto.toggleable ?? false,
            status: clip(auto.status ?? ''),
          },
    autoDream:
      dream === undefined
        ? null
        : {
            shown: dream.shown ?? false,
            enabled: dream.enabled ?? false,
            toggleable: dream.toggleable ?? false,
            status: clip(dream.status ?? ''),
            detail: clip(dream.detail ?? ''),
          },
    truncated: files.truncated || folders.truncated || memories.truncated,
    extra: extraRows(raw, keysOf(memorySchema), 'memory', unknown),
  };
}

// ---- skills ----

const skillSchema = z.looseObject({
  name: z.string().min(1),
  display_name: optText,
  description: optText,
  source: optText,
  tokens: optNumber,
  state: optText,
  locked_by: z.string().nullish().catch(null),
  // Known, not shown: `advertised` (slash-command join), `handles` (settings keys for an edit).
  advertised: z.unknown().optional(),
  handles: z.unknown().optional(),
});
const skillsSchema = z.looseObject({ skills: z.array(z.unknown()) });

function skillsOf(raw: unknown, unknown: Unknown): SessionInfoOf<'skills'> | null {
  const parsed = skillsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const skills = rowsOf(
    parsed.data.skills,
    skillSchema,
    (s) => ({
      name: clip(s.name),
      displayName: clip(s.display_name ?? s.name),
      description: clip(s.description ?? ''),
      source: clip(s.source ?? ''),
      tokens: s.tokens !== undefined && Number.isFinite(s.tokens) && s.tokens >= 0 ? s.tokens : null,
      state: clip(s.state ?? ''),
      lockedBy: s.locked_by === null || s.locked_by === undefined ? null : clip(s.locked_by),
    }),
    'skills.skills',
    unknown,
  );
  return {
    section: 'skills',
    skills: skills.rows,
    truncated: skills.truncated,
    extra: extraRows(raw, keysOf(skillsSchema), 'skills', unknown),
  };
}

// ---- hooks ----

const hookEventSchema = z.looseObject({
  name: z.string().min(1),
  summary: optText,
  supportsMatcher: optBool,
  hookCount: optNumber,
});
const hookSchema = z.looseObject({
  event: z.string().min(1),
  matcher: optText,
  source: optText,
  sourceLabel: optText,
  pluginName: optText,
  type: optText,
  displayText: optText,
  commandText: optText,
  contentLabel: optText,
  condition: optText,
  timeout: optNumber,
  statusMessage: optText,
  runsOnce: optBool,
  runsInBackground: optBool,
  disabled: optBool,
  // Known, never passed on: the stored entry for an edit form (raw config, headers blanked).
  editable: z.unknown().optional(),
});
const hooksSchema = z.looseObject({
  events: z.array(z.unknown()).optional().catch(undefined),
  hooks: z.array(z.unknown()),
  // Known, not shown: every event for an add-hook form.
  eventCatalog: z.unknown().optional(),
  policy: z
    .looseObject({
      disabledByPolicy: optBool,
      managedOnly: optBool,
      pluginOnly: optBool,
      allDisabled: optBool,
      policyHookCount: optNumber,
      policyUnreadable: optBool,
    })
    .optional()
    .catch(undefined),
  safeMode: z.looseObject({ managedHooksStillApply: optBool, exitHint: optText }).optional().catch(undefined),
  bareMode: z.looseObject({ exitHint: optText }).optional().catch(undefined),
  errors: z.unknown().optional(),
});

const count = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

function hooksOf(raw: unknown, unknown: Unknown): SessionInfoOf<'hooks'> | null {
  const parsed = hooksSchema.safeParse(raw);
  if (!parsed.success) return null;
  const h = parsed.data;
  const events = rowsOf(
    h.events,
    hookEventSchema,
    (e) => ({
      name: clip(e.name),
      summary: clip(e.summary ?? ''),
      matcherSupported: e.supportsMatcher ?? false,
      count: count(e.hookCount),
    }),
    'hooks.events',
    unknown,
  );
  const hooks = rowsOf(
    h.hooks,
    hookSchema,
    (k) => {
      const command = k.commandText ?? '';
      return {
        event: clip(k.event),
        matcher: clip(k.matcher ?? ''),
        source: clip(k.source ?? ''),
        sourceLabel: clip(k.sourceLabel ?? k.source ?? ''),
        pluginName: k.pluginName === undefined ? null : clip(k.pluginName),
        type: clip(k.type ?? ''),
        displayText: clip(k.displayText ?? command),
        command: clip(command),
        contentLabel: clip(k.contentLabel ?? ''),
        condition: k.condition === undefined ? null : clip(k.condition),
        timeoutSec:
          k.timeout !== undefined && Number.isFinite(k.timeout) && k.timeout >= 0 ? k.timeout : null,
        statusMessage: k.statusMessage === undefined ? null : clip(k.statusMessage),
        once: k.runsOnce ?? false,
        background: k.runsInBackground ?? false,
        disabled: k.disabled ?? false,
      };
    },
    'hooks.hooks',
    unknown,
  );
  const p = h.policy;
  return {
    section: 'hooks',
    events: events.rows,
    hooks: hooks.rows,
    policy:
      p === undefined
        ? null
        : {
            disabledByPolicy: p.disabledByPolicy ?? false,
            managedOnly: p.managedOnly ?? false,
            pluginOnly: p.pluginOnly ?? false,
            allDisabled: p.allDisabled ?? false,
            policyHookCount: count(p.policyHookCount),
            policyUnreadable: p.policyUnreadable ?? false,
          },
    safeMode:
      h.safeMode === undefined
        ? null
        : {
            managedHooksStillApply: h.safeMode.managedHooksStillApply ?? false,
            exitHint: clip(h.safeMode.exitHint ?? ''),
          },
    bareMode: h.bareMode === undefined ? null : { exitHint: clip(h.bareMode.exitHint ?? '') },
    errors: settingsErrors(h.errors, 'hooks.errors', unknown),
    truncated: events.truncated || hooks.truncated,
    extra: extraRows(raw, keysOf(hooksSchema), 'hooks', unknown),
  };
}

// ---- permissions ----

const ruleSchema = z.looseObject({
  behavior: z.enum(['allow', 'ask', 'deny']),
  source: optText,
  rule: z.string(),
  description: z
    .looseObject({ prefix: z.string().catch(''), emphasis: optText, suffix: optText })
    .optional()
    .catch(undefined),
  editability: optText,
  notInEffect: optBool,
});
const directorySchema = z.looseObject({ path: z.string().min(1), source: optText });
const rulesStateSchema = z.looseObject({
  rules: z.array(z.unknown()),
  workspaceDirectories: z.array(z.unknown()).optional().catch(undefined),
  originalCwd: optText,
  managedOnly: optBool,
  errors: z.unknown().optional(),
});
const rulesAnswerSchema = z.looseObject({ state: z.unknown() });

function permissionsOf(raw: unknown, unknown: Unknown): SessionInfoOf<'permissions'> | null {
  // SDK 0.3.322 hands over the wire answer `{state}`; the bare state is taken as well.
  const wrapped = rulesAnswerSchema.safeParse(raw);
  const state = wrapped.success ? wrapped.data.state : raw;
  if (wrapped.success) unknown.extraKeys(raw, keysOf(rulesAnswerSchema), 'permissions');
  const parsed = rulesStateSchema.safeParse(state);
  if (!parsed.success) return null;
  const s = parsed.data;
  const rules = rowsOf(
    s.rules,
    ruleSchema,
    (r) => ({
      behavior: r.behavior,
      source: clip(r.source ?? ''),
      rule: clip(r.rule),
      description:
        r.description === undefined
          ? null
          : {
              prefix: clip(r.description.prefix),
              emphasis: r.description.emphasis === undefined ? null : clip(r.description.emphasis),
              suffix: r.description.suffix === undefined ? null : clip(r.description.suffix),
            },
      editability: clip(r.editability ?? ''),
      notInEffect: r.notInEffect ?? false,
    }),
    'permissions.rules',
    unknown,
  );
  const directories = rowsOf(
    s.workspaceDirectories,
    directorySchema,
    (d) => ({ path: clip(d.path), source: clip(d.source ?? '') }),
    'permissions.directories',
    unknown,
  );
  const cwd = s.originalCwd?.trim() ?? '';
  return {
    section: 'permissions',
    rules: rules.rows,
    directories: directories.rows,
    cwd: cwd === '' ? null : clip(cwd),
    managedOnly: s.managedOnly ?? false,
    errors: settingsErrors(s.errors, 'permissions.errors', unknown),
    truncated: rules.truncated || directories.truncated,
    extra: extraRows(state, keysOf(rulesStateSchema), 'permissions.state', unknown),
  };
}

// ---- mcp ----

const mcpServerSchema = z.looseObject({
  name: z.string().min(1),
  status: optText,
  error: optText,
  scope: optText,
  source: optText,
  config: z.looseObject({ type: optText }).optional().catch(undefined),
  serverInfo: z.looseObject({ name: optText, version: optText }).optional().catch(undefined),
  tools: z
    .array(z.looseObject({ name: z.string() }))
    .optional()
    .catch(undefined),
});
const mcpAnswerSchema = z.looseObject({ mcpServers: z.array(z.unknown()) });

function serverVersionOf(
  info: { name?: string | undefined; version?: string | undefined } | undefined,
): string | null {
  if (info === undefined) return null;
  const text = [info.name, info.version].filter((part) => part !== undefined && part !== '').join(' ');
  return text === '' ? null : clip(text);
}

function mcpOf(raw: unknown, unknown: Unknown): SessionInfoOf<'mcp'> | null {
  // `mcpServerStatus()` unwraps `mcpServers`; the wire answer is taken as well.
  const wrapped = mcpAnswerSchema.safeParse(raw);
  const list = wrapped.success ? wrapped.data.mcpServers : raw;
  if (!Array.isArray(list)) return null;
  const servers = rowsOf(
    list,
    mcpServerSchema,
    (s) => ({
      name: clip(s.name),
      status: clip(s.status ?? ''),
      error: s.error === undefined || s.error === '' ? null : clip(s.error),
      scope: s.scope === undefined ? null : clip(s.scope),
      source: s.source === undefined ? null : clip(s.source),
      transport: s.config?.type === undefined ? null : clip(s.config.type),
      serverVersion: serverVersionOf(s.serverInfo),
      tools: (s.tools ?? []).slice(0, listMax).map((tool) => clip(tool.name)),
    }),
    'mcp.servers',
    unknown,
  );
  return {
    section: 'mcp',
    servers: servers.rows,
    truncated: servers.truncated,
    extra: wrapped.success ? extraRows(raw, keysOf(mcpAnswerSchema), 'mcp', unknown) : [],
  };
}

// ---- export ----

const exportSchema = z.looseObject({ text: z.string(), default_filename: optText });

/** Characters Windows forbids in file names, plus control characters. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const FALLBACK_EXPORT_NAME = 'claude-conversation.txt';

/** The suggested file name made safe for a Windows download, always ending in `.txt`. */
export function exportFileName(raw: string | undefined): string {
  const cleaned = (raw ?? '').replace(FORBIDDEN_NAME_CHARS, '-').replace(/\s+/g, ' ').trim();
  const stem = cleaned
    .replace(/\.txt$/i, '')
    .replace(/[. ]+$/g, '')
    .slice(0, fileNameChars - 4)
    .replace(/[. ]+$/g, '');
  if (stem === '') return FALLBACK_EXPORT_NAME;
  const safe = RESERVED_NAMES.test(stem) ? `_${stem}` : stem;
  return `${safe.slice(0, fileNameChars - 4)}.txt`;
}

function exportOf(raw: unknown, unknown: Unknown): SessionInfoOf<'export'> | null {
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success) return null;
  unknown.extraKeys(raw, keysOf(exportSchema), 'export');
  const text = parsed.data.text;
  return {
    section: 'export',
    text: text.length > exportChars ? text.slice(0, exportChars) : text,
    filename: exportFileName(parsed.data.default_filename),
    totalChars: text.length,
    truncated: text.length > exportChars,
  };
}

// ---- entry points ----

const PARSERS: {
  [S in SessionInfoSectionName]: (raw: unknown, unknown: Unknown) => SessionInfoOf<S> | null;
} = {
  status: statusOf,
  memory: memoryOf,
  skills: skillsOf,
  hooks: hooksOf,
  permissions: permissionsOf,
  mcp: mcpOf,
  export: exportOf,
};

/**
 * The raw answer of one section → its display form; `data: null` = unknown shape (treated like a
 * missing method: the tab says "not available with this claude version"). The result is checked
 * against the contract once more, so nothing invalid can reach the wire.
 */
export function sessionInfoOf(section: SessionInfoSectionName, raw: unknown): ParsedSessionInfo {
  const unknown = new Unknown();
  const data = PARSERS[section](raw, unknown);
  if (data === null) return { data: null, unknown: unknown.list() };
  const checked = sessionInfoSectionSchema.safeParse(data);
  return { data: checked.success ? checked.data : null, unknown: unknown.list() };
}

/** An older CLI answers a request it does not know with an "unsupported/unknown subtype" error. */
const UNSUPPORTED_REQUEST = /\b(?:unsupported|unknown)\b.*\b(?:subtype|control request)\b/i;
/**
 * The CLI refuses the request on this connection/build/host ("get_status is not available in this
 * build", "… on this connection", "… in a cloud-hosted session").
 */
const NOT_AVAILABLE = /\bis not available (?:in this build|on this connection|in a cloud-hosted session)\b/i;

/**
 * A rejected info request: `unavailable` = this CLI cannot answer it (the tab says so, no error),
 * `failed` = anything else (timeout, CLI error – the tab shows CLAUDE_CONTROL_FAILED).
 */
export function sessionInfoFailure(error: unknown): 'unavailable' | 'failed' {
  const message = toError(error).message;
  return UNSUPPORTED_REQUEST.test(message) || NOT_AVAILABLE.test(message) ? 'unavailable' : 'failed';
}
