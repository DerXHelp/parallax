/**
 * What the system integration last reached (ADR-229): `<home>/system-integration.json`. A server
 * start with an unchanged fingerprint – the wanted state, the start command (node.exe, arguments,
 * working directory) and, for shortcuts, size and time of the `.lnk` – does not touch the
 * shortcuts or the registry again: no PowerShell, no reg.exe. Rewriting autostart and registry
 * entries at every start looks like persistence to behaviour-based security software.
 *
 * Lost, unreadable or from another version → empty: everything is reconciled once more (harmless).
 * A test run never gets the file store without an injected memo (system/run.ts, R6) – it keeps the
 * memo in memory instead.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { writeFileAtomic } from '../lib/fs';
import { isTestProcess } from './run';

export const SYSTEM_MEMO_FILE = 'system-integration.json';

const fingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u)
  .nullable()
  .default(null);

const memoFileSchema = z.object({
  schemaVersion: z.literal(1),
  autostart: fingerprintSchema,
  protocol: fingerprintSchema,
  /** The handler of `protocol` is this server's own (not an installation's) → toasts get the URI. */
  registered: z.boolean().default(false),
  startMenu: fingerprintSchema,
});

export interface SystemMemoData {
  autostart: string | null;
  protocol: string | null;
  registered: boolean;
  startMenu: string | null;
}

export const EMPTY_SYSTEM_MEMO: SystemMemoData = {
  autostart: null,
  protocol: null,
  registered: false,
  startMenu: null,
};

/** Never throws: a failed read is an empty memo, a failed write is only logged. */
export interface SystemMemo {
  read(): Promise<SystemMemoData>;
  write(data: SystemMemoData): Promise<void>;
}

/** SHA-256 (hex) over the JSON of `value` – the same input gives the same fingerprint. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/** Size and modification time of a shortcut, or `absent` – a plain `stat`, no process. */
export async function fileState(file: string): Promise<string> {
  try {
    const info = await stat(file);
    return `${String(info.size)}:${String(Math.trunc(info.mtimeMs))}`;
  } catch {
    return 'absent';
  }
}

export function memoryMemo(
  initial: SystemMemoData = EMPTY_SYSTEM_MEMO,
): SystemMemo & { data: () => SystemMemoData } {
  let data = { ...initial };
  return {
    read: () => Promise.resolve({ ...data }),
    write: (next) => {
      data = { ...next };
      return Promise.resolve();
    },
    data: () => ({ ...data }),
  };
}

export function fileMemo(home: string, log: Logger): SystemMemo {
  const file = path.join(home, SYSTEM_MEMO_FILE);
  return {
    async read() {
      try {
        const parsed = memoFileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')) as unknown);
        if (!parsed.success) return { ...EMPTY_SYSTEM_MEMO };
        const { schemaVersion: _version, ...data } = parsed.data;
        return data;
      } catch {
        return { ...EMPTY_SYSTEM_MEMO };
      }
    },
    async write(data) {
      try {
        await writeFileAtomic(file, `${JSON.stringify({ schemaVersion: 1, ...data }, null, 2)}\n`);
      } catch (error) {
        log.warn({ err: error }, 'system integration memo not written');
      }
    },
  };
}

/** The injected memo, else the file in `home` – which a test run never gets (memory instead). */
export function systemMemo(memo: SystemMemo | undefined, home: string, log: Logger): SystemMemo {
  if (memo !== undefined) return memo;
  return isTestProcess() ? memoryMemo() : fileMemo(home, log);
}
