/**
 * Slash-command catalog per entry (ADR-108/114): `supportedCommands()` → `SlashCommandInfo[]`
 * (tolerant like `toModelCatalog`: unusable entries are skipped, missing fields get defaults) and
 * the per-entry cache `PARALLAX_HOME/entries/<entryId>/commands.json` (server-internal schema
 * `{schemaVersion: 1, commands, at}`), so the composer menu of a dormant entry is filled. Every
 * change of `detail.commands` – the engine at readiness and the normalizer's `commands_changed` –
 * replaces the cached list (the last one wins, "two writers" rule of sessions/ports.ts).
 *
 * The cache is best effort: writes go through `writeFileAtomic` (one writer per entry, coalesced),
 * failures are logged; an unreadable, invalid or newer file reads as "no cache".
 */
import path from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { isoDateTimeSchema, type EntryId } from '@shared/common';
import { slashCommandInfoSchema, type SlashCommandInfo } from '@shared/model';
import { nodeFsOps, withFsRetry, writeFileAtomic, type FsOps } from '../lib/fs';
import { logger as rootLogger } from '../lib/logger';
import { fsErrorCode } from '../lib/paths';
import { entryDir } from '../store/decisions';

export const COMMANDS_FILE = 'commands.json';
export const COMMANDS_SCHEMA_VERSION = 1;

export const commandsCacheFileSchema = z.object({
  schemaVersion: z.literal(COMMANDS_SCHEMA_VERSION),
  commands: z.array(slashCommandInfoSchema),
  at: isoDateTimeSchema,
});
export type CommandsCacheFile = z.infer<typeof commandsCacheFileSchema>;

const rawCommandSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional().catch(undefined),
  argumentHint: z.string().optional().catch(undefined),
  aliases: z.array(z.string()).optional().catch(undefined),
  builtin: z.boolean().optional().catch(undefined),
});

/** `supportedCommands()` answer → catalog (unknown shapes skipped, first entry of a name wins). */
export function toSlashCommands(raw: unknown): SlashCommandInfo[] {
  const list = z.array(z.unknown()).safeParse(raw);
  if (!list.success) return [];
  const seen = new Set<string>();
  const out: SlashCommandInfo[] = [];
  for (const item of list.data) {
    const parsed = rawCommandSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.name)) continue;
    const c = parsed.data;
    seen.add(c.name);
    out.push({
      name: c.name,
      description: c.description ?? '',
      argumentHint: c.argumentHint ?? '',
      aliases: c.aliases ?? [],
      builtin: c.builtin ?? false,
    });
  }
  return out;
}

export interface CommandCatalogStore {
  /** The cached list of an entry, or null (no cache, unreadable, newer schema). Never throws. */
  load(entryId: EntryId): Promise<SlashCommandInfo[] | null>;
  /** Replaces the cache (written in the background, coalesced per entry). */
  save(entryId: EntryId, commands: readonly SlashCommandInfo[]): void;
  /** Waits for every pending write. */
  flush(): Promise<void>;
}

export interface CommandCatalogStoreOptions {
  home: string;
  fs?: FsOps;
  now?: () => Date;
  logger?: Logger;
}

interface WriteSlot {
  latest: CommandsCacheFile | null;
  running: Promise<void> | null;
}

export function createCommandCatalogStore(options: CommandCatalogStoreOptions): CommandCatalogStore {
  const fs = options.fs ?? nodeFsOps;
  const now = options.now ?? (() => new Date());
  const log = (options.logger ?? rootLogger).child({ module: 'commandCatalog' });
  /** Last known list per entry (saved or read) – reads after a save never see an older file. */
  const known = new Map<EntryId, SlashCommandInfo[]>();
  const slots = new Map<EntryId, WriteSlot>();
  const fileOf = (entryId: EntryId): string => path.join(entryDir(options.home, entryId), COMMANDS_FILE);

  const drain = async (entryId: EntryId, slot: WriteSlot): Promise<void> => {
    try {
      for (let next = slot.latest; next !== null; next = slot.latest) {
        slot.latest = null;
        try {
          await writeFileAtomic(fileOf(entryId), `${JSON.stringify(next, null, 2)}\n`, { fs });
        } catch (error) {
          log.warn({ err: error, entryId }, 'commands.json could not be written');
        }
      }
    } finally {
      slot.running = null;
    }
  };

  return {
    async load(entryId) {
      const cached = known.get(entryId);
      if (cached !== undefined) return structuredClone(cached);
      let text: string;
      try {
        text = await withFsRetry(() => fs.readFile(fileOf(entryId)));
      } catch (error) {
        if (fsErrorCode(error) !== 'ENOENT') log.debug({ err: error, entryId }, 'commands.json unreadable');
        return null;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        log.debug({ entryId }, 'commands.json is no JSON – ignored');
        return null;
      }
      const parsed = commandsCacheFileSchema.safeParse(json);
      if (!parsed.success) {
        log.debug({ entryId }, 'commands.json does not match its schema – ignored');
        return null;
      }
      // A save may have landed while the file was read: the newer list wins.
      const latest = known.get(entryId) ?? parsed.data.commands;
      known.set(entryId, latest);
      return structuredClone(latest);
    },

    save(entryId, commands) {
      const list = commands.map((c) => slashCommandInfoSchema.parse(c));
      known.set(entryId, list);
      const slot = slots.get(entryId) ?? { latest: null, running: null };
      slots.set(entryId, slot);
      slot.latest = { schemaVersion: COMMANDS_SCHEMA_VERSION, commands: list, at: now().toISOString() };
      slot.running ??= drain(entryId, slot);
    },

    async flush() {
      for (;;) {
        const running = [...slots.values()].flatMap((slot) => (slot.running === null ? [] : [slot.running]));
        if (running.length === 0) return;
        await Promise.all(running);
      }
    },
  };
}

export interface MemoryCommandCatalogStore extends CommandCatalogStore {
  /** Every save in order. */
  readonly saves: readonly { entryId: EntryId; commands: SlashCommandInfo[] }[];
}

export function createMemoryCommandCatalogStore(
  seed: Readonly<Record<string, readonly SlashCommandInfo[]>> = {},
): MemoryCommandCatalogStore {
  const lists = new Map<string, SlashCommandInfo[]>(
    Object.entries(seed).map(([entryId, list]) => [
      entryId,
      list.map((c) => slashCommandInfoSchema.parse(c)),
    ]),
  );
  const saves: { entryId: EntryId; commands: SlashCommandInfo[] }[] = [];
  return {
    saves,
    load: (entryId) => {
      const list = lists.get(entryId);
      return Promise.resolve(list === undefined ? null : structuredClone(list));
    },
    save: (entryId, commands) => {
      const list = commands.map((c) => slashCommandInfoSchema.parse(c));
      lists.set(entryId, list);
      saves.push({ entryId, commands: structuredClone(list) });
    },
    flush: () => Promise.resolve(),
  };
}
