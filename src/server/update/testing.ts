/**
 * Test support (WP-87, imported only by tests – the integration of WP-89 and the route tests): a
 * fake `UpdateService` whose state the test controls. It records every command, upload, settings
 * hook and request, answers commands like the contract (`update.check` → the available version,
 * the others `{}`; `update.dismiss` clears its field like the real service) unless a failure is
 * queued, and never touches the network, a process or the disk.
 */
import os from 'node:os';
import path from 'node:path';
import type { ErrorPayload } from '@shared/errors';
import type { ChangelogQuery, ChangelogResponse, NoticeFile, NoticesResponse } from '@shared/http';
import { DEFAULT_UPDATE_STATE, type AppInfo, type Settings, type UpdateState } from '@shared/model';
import type { HostCommand } from '@shared/protocol';
import { CommandError } from '../sync/ports';
import { UPDATE_COMMAND_NAMES, type UpdateService } from './ports';

export type UpdateCommandName = (typeof UPDATE_COMMAND_NAMES)[number];

export interface FakeUpdateOptions {
  app?: Partial<AppInfo>;
  state?: Partial<UpdateState>;
  /** Folder of `uploadFile()` (default: the test home or the temp folder). */
  uploadDir?: string;
}

export interface FakeUpdateService extends UpdateService {
  /** Every command handed to `handle`, in order (also the failed ones). */
  readonly commands: HostCommand[];
  /** Files passed to `acceptPackage`. */
  readonly accepted: string[];
  readonly settingsSeen: Settings[];
  readonly changelogQueries: ChangelogQuery[];
  readonly noticeRequests: NoticeFile[];
  started(): boolean;
  closed(): boolean;
  listenerCount(): number;
  /** Replaces parts of the state and notifies the listeners. */
  setState(patch: Partial<UpdateState>): void;
  /** The next command of this name fails with `error` (once). */
  failNext(name: UpdateCommandName, error: ErrorPayload): void;
  setUploadIssue(error: ErrorPayload | null): void;
  setOrchestratorPid(pid: number | null): void;
  /** Answer of `changelog()`: a response or an error to throw (default FILE_NOT_FOUND). */
  setChangelog(answer: ChangelogResponse | ErrorPayload): void;
  /** Answer of `notice()` (default: the file name as text). */
  setNotice(answer: NoticesResponse | ErrorPayload): void;
}

function isError(value: object): value is ErrorPayload {
  return 'code' in value;
}

export function createFakeUpdateService(options: FakeUpdateOptions = {}): FakeUpdateService {
  const app: AppInfo = { version: '1.0.0', buildId: '1.0.0+fake', packaged: true, ...options.app };
  let state: UpdateState = {
    ...DEFAULT_UPDATE_STATE,
    status: app.packaged ? 'idle' : 'unsupported',
    ...options.state,
  };
  const listeners = new Set<() => void>();
  const failures = new Map<UpdateCommandName, ErrorPayload>();
  const commands: HostCommand[] = [];
  const accepted: string[] = [];
  const settingsSeen: Settings[] = [];
  const changelogQueries: ChangelogQuery[] = [];
  const noticeRequests: NoticeFile[] = [];
  let uploadIssue: ErrorPayload | null = null;
  let orchestrator: number | null = null;
  let changelogAnswer: ChangelogResponse | ErrorPayload = { code: 'FILE_NOT_FOUND', params: {} };
  let noticeAnswer: NoticesResponse | ErrorPayload | null = null;
  let isStarted = false;
  let isClosed = false;
  let uploads = 0;
  const uploadDir = options.uploadDir ?? process.env.PARALLAX_HOME ?? os.tmpdir();

  const setState = (patch: Partial<UpdateState>): void => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  return {
    names: UPDATE_COMMAND_NAMES,
    commands,
    accepted,
    settingsSeen,
    changelogQueries,
    noticeRequests,

    handle(cmd: HostCommand): Promise<unknown> {
      commands.push(cmd);
      const known = UPDATE_COMMAND_NAMES.find((name) => name === cmd.name);
      const failure = known === undefined ? undefined : failures.get(known);
      if (known !== undefined && failure !== undefined) {
        failures.delete(known);
        return Promise.reject(new CommandError(failure));
      }
      switch (cmd.name) {
        case 'update.check':
          return Promise.resolve({ available: state.available?.version ?? null });
        case 'update.dismiss':
          if (cmd.what === 'available') setState({ dismissedVersion: state.available?.version ?? null });
          else if (cmd.what === 'justUpdated') setState({ justUpdated: null });
          else if (cmd.what === 'failedUpdate') setState({ failedUpdate: null });
          else setState({ error: null });
          return Promise.resolve({});
        case 'update.prepare':
        case 'update.apply':
        case 'update.rollback':
          return Promise.resolve({});
        default:
          return Promise.reject(new CommandError({ code: 'NOT_IMPLEMENTED', params: {} }));
      }
    },

    app: () => app,
    state: () => state,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      isStarted = true;
    },
    settingsChanged(next) {
      settingsSeen.push(next);
    },
    uploadIssue: () => uploadIssue,
    uploadFile: () => path.join(uploadDir, `upload-fake-${String(++uploads)}.zip`),
    acceptPackage(file) {
      accepted.push(file);
    },
    changelog(query) {
      changelogQueries.push(query);
      const answer = changelogAnswer;
      return isError(answer) ? Promise.reject(new CommandError(answer)) : Promise.resolve(answer);
    },
    notice(file) {
      noticeRequests.push(file);
      const answer = noticeAnswer ?? { file, text: file };
      return isError(answer) ? Promise.reject(new CommandError(answer)) : Promise.resolve(answer);
    },
    orchestratorPid: () => orchestrator,
    close() {
      isClosed = true;
      listeners.clear();
      return Promise.resolve();
    },

    started: () => isStarted,
    closed: () => isClosed,
    listenerCount: () => listeners.size,
    setState,
    failNext(name, error) {
      failures.set(name, error);
    },
    setUploadIssue(error) {
      uploadIssue = error;
    },
    setOrchestratorPid(pid) {
      orchestrator = pid;
    },
    setChangelog(answer) {
      changelogAnswer = answer;
    },
    setNotice(answer) {
      noticeAnswer = answer;
    },
  };
}
