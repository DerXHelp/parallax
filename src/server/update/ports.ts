/**
 * Port of the update service (WP-87, docs/wp/WP-87.md §1.7): `update.*` host commands, the state
 * for `HostState.app` / `HostState.update`, the upload of "Install from file", "What's new" and the
 * notices. Implemented by WP-87a (`createUpdateService`), wired by WP-89 (app/compose.ts).
 * Frozen like every `ports.ts`: changes only via the coordinator.
 */
import type { Logger } from 'pino';
import type { ErrorPayload } from '@shared/errors';
import type { ChangelogQuery, ChangelogResponse, NoticeFile, NoticesResponse } from '@shared/http';
import type { AppInfo, Settings, UpdateState } from '@shared/model';
import type { HostCommandName } from '@shared/protocol';
import type { ServerInstance } from '../config';
import type { ReleaseInfo } from '../launcher/release';
import type { HostCommandHandler } from '../sync/ports';

export const UPDATE_COMMAND_NAMES = [
  'update.check',
  'update.prepare',
  'update.apply',
  'update.rollback',
  'update.dismiss',
] as const satisfies readonly HostCommandName[];

export interface UpdateService extends HostCommandHandler {
  app(): AppInfo;
  state(): UpdateState;
  /** Status changes at once, progress at most twice a second; returns the unsubscribe function. */
  onChange(listener: () => void): () => void;
  /** After the lock file: first check after 60 s, then every 12 h (only packaged && updates.check). */
  start(): void;
  /** After every settings.update (`updates.check` on/off). */
  settingsChanged(next: Settings): void;
  /** Upload route: null = an upload may start; else the error to answer with (UPDATE_BUSY, …). */
  uploadIssue(): ErrorPayload | null;
  /** A fresh file below `<root>\downloads` for the streamed upload. */
  uploadFile(): string;
  /** The zip was written completely: checked and staged in the background (HostState.update). */
  acceptPackage(file: string): void;
  /** `GET /api/changelog`; throws CommandError (FILE_NOT_FOUND, UPDATE_NOT_PACKAGED …). */
  changelog(query: ChangelogQuery): Promise<ChangelogResponse>;
  /** `GET /api/notices` of the running version; throws CommandError (FILE_NOT_FOUND). */
  notice(file: NoticeFile): Promise<NoticesResponse>;
  /** The orchestrator after its handshake: the shutdown sweep spares its process tree. */
  orchestratorPid(): number | null;
  /** Shutdown step: timers, a running download/preparation, partial files. */
  close(): Promise<void>;
}

export interface UpdateServiceOptions {
  home: string;
  /** `--install-root` of an installation; null = checkout/dev (status `unsupported`). */
  installRoot: string | null;
  /** Version folder (package) or checkout (src/server/main.ts). */
  repoRoot: string;
  /** release.json of the running version (null outside a package). */
  release: ReleaseInfo | null;
  instance: ServerInstance;
  /** `serverArgsFor(config)` (launcher/args.ts): the new version starts with the same flags. */
  serverArgs: readonly string[];
  settings: () => Settings;
  /** compose.ts: restart flag (close 4504), then the ordered shutdown. */
  requestRestart: () => void;
  logger?: Logger;
}
