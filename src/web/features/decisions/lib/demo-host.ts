import { LOCAL_HOST_ID, makeSessionKey, type EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import type { HostState, SessionSummary } from '@shared/model';
import type { Command, SessionSnapshot } from '@shared/protocol';
import { sampleFileInfo, sampleHostState } from '@shared/samples';
import {
  createHostConnection,
  registerConnection,
  unregisterConnection,
  type ManagedHostConnection,
} from '@web/state/connection';
import { FakeHost, type FakeAck } from '@web/state/fake-host';
import { setSelectedSession } from '@web/state/selection';
import { createMemoryTransport } from '@web/state/transport';
import { PlanFileError, setPlanFileReader } from '../state/plan-data';
import type { DemoPlanVersion } from './demo-data';

/**
 * A FakeHost behind a real HostConnection on host `local` (same code path as the app) for the
 * playground demos and the component tests of WP-16 – with own sessions and command handling
 * (`startScenario` of WP-14 only knows its fixed scenarios). WP-56: `plan.list`/`plan.read` answer
 * per entry from `planVersions`, the plan files live in the FakeHost's file table and the plan tab
 * reads them through `setPlanFileReader` (there is no `/api/file`). Dev/test only: nothing in the
 * app imports this module.
 */

export interface DemoHostOptions {
  summaries: readonly SessionSummary[];
  sessions: readonly SessionSnapshot[];
  hostState?: HostState;
  onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined;
  replyToPrompts?: boolean;
  /** Session selected in the window (default: none). */
  select?: string | null;
  /** Ops are applied right away instead of once per animation frame (tests). */
  immediate?: boolean;
  /** Stored plan versions per entry, ascending (an entry without any answers `plan.list` with []). */
  planVersions?: Partial<Record<EntryId, DemoPlanVersion[]>>;
  /** Plan files (path → text) added to the FakeHost's file table. */
  planFiles?: Readonly<Record<string, string>>;
}

export interface DemoHost {
  host: FakeHost;
  connection: ManagedHostConnection;
  sessionKey(entryId: EntryId): string;
  /** Stored plan versions per entry (mutable: a demo adds a version, then pushes its decision). */
  planVersions: Map<EntryId, DemoPlanVersion[]>;
  /** Adds or replaces a plan file of the table (text/markdown, access `session`). */
  setPlanFile(path: string, text: string): void;
  stop(): void;
}

/** `plan.list`/`plan.read` of the demo sessions (WP-51 semantics: unknown version → PLAN_NOT_FOUND). */
function planCommand(
  cmd: Command,
  host: FakeHost,
  versions: ReadonlyMap<EntryId, DemoPlanVersion[]>,
): FakeAck | undefined {
  if (cmd.name !== 'plan.list' && cmd.name !== 'plan.read') return undefined;
  if (host.view(cmd.entryId) === null) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
  const stored = versions.get(cmd.entryId) ?? [];
  if (cmd.name === 'plan.list') return { ok: true, result: { versions: stored.map((entry) => entry.info) } };
  const found = stored.find((entry) => entry.info.version === cmd.version);
  if (found?.info.stored !== true) {
    return { ok: false, error: makeError('PLAN_NOT_FOUND', { version: cmd.version }) };
  }
  return { ok: true, result: { version: cmd.version, text: found.text } };
}

export function startDemoHost(options: DemoHostOptions): DemoHost {
  unregisterConnection(LOCAL_HOST_ID);
  const transport = createMemoryTransport();
  const planVersions = new Map<EntryId, DemoPlanVersion[]>();
  for (const [entryId, versions] of Object.entries(options.planVersions ?? {})) {
    if (versions !== undefined) planVersions.set(entryId, [...versions]);
  }
  const { onCommand } = options;
  const host = new FakeHost({
    transport,
    // A new instance id per run: the client treats it like a fresh server (no stale seqs).
    serverInstanceId: crypto.randomUUID(),
    hostState: options.hostState ?? sampleHostState(),
    summaries: options.summaries,
    sessions: options.sessions,
    onCommand: (cmd, fake) => onCommand?.(cmd, fake) ?? planCommand(cmd, fake, planVersions),
    replyToPrompts: options.replyToPrompts ?? false,
  });
  const setPlanFile = (path: string, text: string) => {
    host.setFile({
      info: sampleFileInfo({
        path,
        realPath: path,
        kind: 'markdown',
        mediaType: 'text/plain; charset=utf-8',
        bytes: new TextEncoder().encode(text).length,
        mtimeMs: Date.parse(host.now()),
        access: 'session',
      }),
      text: () => text,
    });
  };
  for (const [path, text] of Object.entries(options.planFiles ?? {})) setPlanFile(path, text);
  setPlanFileReader((file) => {
    const stat = host.statFile(file.entryId, file.path);
    if (!stat.ok) return Promise.reject(new PlanFileError(stat.error));
    const text = host.fileText(file.path);
    return text === null
      ? Promise.reject(new PlanFileError(makeError('FILE_NOT_READABLE')))
      : Promise.resolve(text);
  });
  let reloadAt: number | null = null;
  const connection = createHostConnection({
    hostId: LOCAL_HOST_ID,
    createTransport: () => transport,
    reload: () => undefined,
    reloadGuard: {
      read: () => reloadAt,
      write: (at) => {
        reloadAt = at;
      },
    },
    ...(options.immediate === true
      ? {
          scheduleFrame: (callback: () => void) => {
            callback();
          },
        }
      : {}),
  });
  registerConnection(connection);
  connection.start();
  if (options.select !== undefined) setSelectedSession(options.select, { updateHash: false });
  return {
    host,
    connection,
    sessionKey: (entryId) => makeSessionKey(LOCAL_HOST_ID, entryId),
    planVersions,
    setPlanFile,
    stop() {
      setPlanFileReader(null);
      unregisterConnection(LOCAL_HOST_ID);
      host.dispose();
    },
  };
}
