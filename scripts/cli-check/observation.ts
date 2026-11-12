/**
 * What one probe of `pnpm cli-check` observed (WP-62) – the profile fields without the bookkeeping
 * (`schemaVersion`, `checkedAt`) – and the pure extraction from the raw SDK answers. The raw values
 * are parsed tolerantly (zod, unknown fields kept as keys only): `system/init`,
 * `initializationResult()`, `supportedModels()`, `getContextUsage()`. Never stores values of
 * account fields (`initializationResult().account` holds e-mail/org: only its key is kept).
 */
import { z } from 'zod';
import {
  CLI_PROFILE_SCHEMA_VERSION,
  cliProfileSchema,
  type CliProfile,
} from '../../src/server/claude/cliProfile';

export const observationSchema = cliProfileSchema.omit({ schemaVersion: true, checkedAt: true });
export type Observation = z.infer<typeof observationSchema>;

/** Sorted (code-unit order, locale-independent), without duplicates. */
export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

const stringList = z.array(z.unknown()).transform((items) =>
  items.filter((item): item is string => typeof item === 'string'),
);

/** The fields of `system/init` the check reads; everything else only counts as a key. */
const initSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  model: z.string().catch(''),
  permissionMode: z.string().catch(''),
  output_style: z.string().catch(''),
  tools: stringList.catch([]),
  slash_commands: stringList.catch([]),
  agents: stringList.catch([]),
  skills: stringList.catch([]),
  capabilities: stringList.catch([]),
  apiKeySource: z.string().catch(''),
  claude_code_version: z.string().catch(''),
});
export type InitView = z.infer<typeof initSchema>;

/** `system/init` or null. */
export function parseInit(message: unknown): InitView | null {
  const parsed = initSchema.safeParse(message);
  return parsed.success ? parsed.data : null;
}

const modelsSchema = z.array(z.looseObject({ value: z.string() }));
const contextSchema = z.looseObject({
  categories: z.array(z.looseObject({ id: z.string().optional() })).catch([]),
  deferredBuiltinTools: z.array(z.looseObject({ name: z.string() })).optional().catch(undefined),
});

export interface RawProbe {
  init: unknown;
  initializationResult: unknown;
  supportedModels: unknown;
  contextUsage: unknown;
}

/** MCP tools come from the user's/account's configuration, not from the CLI. */
export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__');
}

/** Keys of a plain object (sorted); anything else → []. */
export function keysOf(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return sortedUnique(Object.keys(value));
}

/**
 * The observation from the raw answers of one probe. Throws when `system/init` is missing or not an
 * init message (the probe cannot be compared without it); the other answers are optional.
 */
export function observationFrom(raw: RawProbe, sdkVersion: string): Observation {
  const init = parseInit(raw.init);
  if (init === null) throw new Error('system/init missing or unreadable');
  const models = modelsSchema.safeParse(raw.supportedModels);
  const context = contextSchema.safeParse(raw.contextUsage);
  const deferred = context.success ? context.data.deferredBuiltinTools : undefined;
  return {
    cliVersion: init.claude_code_version,
    sdkVersion,
    model: init.model,
    permissionMode: init.permissionMode,
    outputStyle: init.output_style,
    initKeys: keysOf(raw.init),
    tools: sortedUnique(init.tools.filter((name) => !isMcpTool(name))),
    deferredTools:
      deferred === undefined
        ? null
        : sortedUnique(deferred.map((tool) => tool.name).filter((name) => !isMcpTool(name))),
    capabilities: sortedUnique(init.capabilities),
    initializationKeys: keysOf(raw.initializationResult),
    models: models.success ? sortedUnique(models.data.map((model) => model.value)) : [],
    contextCategories: context.success
      ? sortedUnique(context.data.categories.flatMap((row) => (row.id === undefined ? [] : [row.id])))
      : [],
    slashCommands: sortedUnique(init.slash_commands),
    agents: sortedUnique(init.agents),
    skills: sortedUnique(init.skills),
  };
}

/** The profile `--accept` writes for an observation. */
export function profileFromObservation(observation: Observation, checkedAt: Date): CliProfile {
  return cliProfileSchema.parse({
    schemaVersion: CLI_PROFILE_SCHEMA_VERSION,
    ...observation,
    checkedAt: checkedAt.toISOString(),
  });
}

/**
 * JSON text of a profile: key order of the schema (zod builds the parsed object in shape order),
 * two-space indent, one list item per line – a new tool is a one-line diff.
 */
export function profileJson(profile: CliProfile): string {
  return `${JSON.stringify(cliProfileSchema.parse(profile), null, 2)}\n`;
}
