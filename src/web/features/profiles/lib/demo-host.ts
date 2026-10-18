import { STANDARD_PROFILE_ID, type ProfileId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type {
  ClaudeInstallStatus,
  HostState,
  Profile,
  ProfileInput,
  ProfileIssue,
  ProfileSummary,
  SessionSummary,
} from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import type { Command } from '@shared/protocol';
import { sampleClaudeInstallStatus, sampleHostState, sampleId, sampleProfile, sampleTime } from '@shared/samples';
import { startNewSessionDemo, type NewSessionDemo } from '@web/shell/new-session/demo-host';
import type { FakeAck, FakeHost } from '@web/state/fake-host';

/**
 * Playground and component tests of WP-36 (never imported by the app): the fake host of
 * `shell/new-session/demo-host.ts` (folder tree for `fs.listDirectory`) plus a small in-memory
 * stand-in for the host commands `profile.*` (`FakeProfileServer`). Its findings only imitate
 * the shapes of the server (WP-32 profileIssues: codes, levels, params) – the real rules live on
 * the server.
 */

// ---- profiles (profile.*) ----

const BLOCKED = new Set(['-p', '--print', '-r', '--resume', '-c', '--continue', '--output-format', '--session-id']);
const WITH_VALUE = new Set(['--model', '--permission-mode', '--settings', '--append-system-prompt', '--mcp-config']);
const MULTI = new Set(['--add-dir', '--allowedTools', '--allowed-tools', '--disallowedTools', '--plugin-dir']);
const BYPASS = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']);
/** `${env:NAME}` references this demo machine resolves. */
const MACHINE_ENV = new Set(['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'HOME']);

type Checkable = Pick<Profile, 'executable' | 'configDir' | 'env' | 'args' | 'passRawArgs'>;

/** Findings in the server's order (errors, warnings, infos); see the module note. */
export function demoProfileIssues(profile: Checkable): ProfileIssue[] {
  const errors: ProfileIssue[] = [];
  const warnings: ProfileIssue[] = [];
  const infos: ProfileIssue[] = [];
  const add = (list: ProfileIssue[], level: ProfileIssue['level'], issue: ErrorPayload) => {
    list.push({ level, issue });
  };
  const args = profile.args;
  let i = 0;
  while (i < args.length) {
    const index = i;
    const entry = args[i] ?? '';
    i += 1;
    if (!entry.startsWith('-')) {
      add(errors, 'error', makeError('PROFILE_ARG_INVALID', { index, flag: entry, reason: 'not_a_flag' }));
      continue;
    }
    const flag = entry.split('=')[0] ?? entry;
    const inline = entry.includes('=');
    const takeValues = (multi: boolean) => {
      let count = 0;
      while (i < args.length && !(args[i] ?? '-').startsWith('-')) {
        i += 1;
        count += 1;
        if (!multi) break;
      }
      return count;
    };
    if (BLOCKED.has(flag.toLowerCase())) {
      add(errors, 'error', makeError('PROFILE_ARG_BLOCKED', { index, flag }));
      if (!inline) takeValues(false);
    } else if (BYPASS.has(flag)) {
      add(warnings, 'warning', makeError('PROFILE_BYPASS_ENABLED', { index, flag }));
    } else if (WITH_VALUE.has(flag) || MULTI.has(flag)) {
      if (!inline && takeValues(MULTI.has(flag)) === 0) {
        add(errors, 'error', makeError('PROFILE_ARG_INVALID', { index, flag, reason: 'missing_value' }));
      }
    } else if (profile.passRawArgs && flag.startsWith('--')) {
      add(infos, 'info', makeError('PROFILE_ARG_PASSED_RAW', { index, flag }));
      if (!inline) takeValues(false);
    } else {
      add(errors, 'error', makeError('PROFILE_ARG_NOT_ALLOWED', { index, flag }));
      if (!inline) takeValues(false);
    }
  }
  if (profile.executable.kind === 'path') {
    const file = profile.executable.path;
    const pathIssue = windowsPathIssue(file);
    const reason =
      pathIssue === 'not_absolute' || pathIssue === 'empty'
        ? 'not_absolute'
        : pathIssue !== null
          ? 'unsafe'
          : !/\.exe$/i.test(file)
            ? 'not_exe'
            : /missing/i.test(file)
              ? 'not_found'
              : null;
    if (reason !== null) {
      errors.push({ level: 'error', issue: makeError('PROFILE_INVALID', { field: 'executable', reason }) });
    }
  }
  if (profile.configDir !== null && windowsPathIssue(profile.configDir) !== null) {
    errors.push({ level: 'error', issue: makeError('PROFILE_INVALID', { field: 'configDir', reason: 'unsafe' }) });
  }
  for (const [key, value] of Object.entries(profile.env)) {
    for (const match of value.matchAll(/\$\{env:([^}]+)\}/g)) {
      const name = match[1] ?? '';
      if (!MACHINE_ENV.has(name.toUpperCase())) {
        add(warnings, 'warning', makeError('PROFILE_ENV_REF_UNRESOLVED', { name, key }));
      }
    }
  }
  return [...errors, ...warnings, ...infos];
}

export interface FakeProfileServerOptions {
  profiles: readonly Profile[];
  /** Entries per profile (delete protection, configDir warning). */
  entryCounts?: Readonly<Partial<Record<ProfileId, number>>>;
  /** Claude Code state per profile (default: ok, signed in). */
  claude?: Readonly<Partial<Record<ProfileId, ClaudeInstallStatus>>>;
  /** Result of `profile.test` per profile (default: the profile's claude state, freshly dated). */
  testResults?: Readonly<Partial<Record<ProfileId, ClaudeInstallStatus>>>;
  /** Extra findings per profile that the check cannot produce (e.g. a vanished executable). */
  extraIssues?: Readonly<Partial<Record<ProfileId, ProfileIssue[]>>>;
}

/** In-memory profile store answering `profile.*`. */
export class FakeProfileServer {
  profiles: Profile[];
  readonly entryCounts: Partial<Record<ProfileId, number>>;
  readonly claude: Partial<Record<ProfileId, ClaudeInstallStatus>>;
  private readonly options: FakeProfileServerOptions;
  private next = 900;

  constructor(options: FakeProfileServerOptions) {
    this.options = options;
    this.profiles = options.profiles.map((profile) => ({ ...profile }));
    this.entryCounts = { ...options.entryCounts };
    this.claude = { ...options.claude };
  }

  issuesOf(profile: Profile): ProfileIssue[] {
    return [...(this.options.extraIssues?.[profile.id] ?? []), ...demoProfileIssues(profile)];
  }

  summaries(): ProfileSummary[] {
    return this.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      color: profile.color,
      isDefault: profile.isDefault,
      builtin: profile.builtin,
      allowsBypass: this.issuesOf(profile).some((finding) => finding.issue.code === 'PROFILE_BYPASS_ENABLED'),
      claude: this.claude[profile.id] ?? sampleClaudeInstallStatus(),
      defaults: {
        model: profile.defaults.model,
        permissionMode: profile.defaults.permissionMode,
        effort: profile.defaults.effort,
      },
      configDir: profile.configDir,
      issues: this.issuesOf(profile),
      entryCount: this.entryCounts[profile.id] ?? 0,
    }));
  }

  hostState(base: HostState): HostState {
    const defaultProfile = this.profiles.find((profile) => profile.isDefault) ?? this.profiles[0];
    return { ...base, profiles: this.summaries(), defaultProfileId: defaultProfile?.id ?? STANDARD_PROFILE_ID };
  }

  /** Answers `profile.*`; anything else (undefined) goes on to the folder tree / FakeHost default. */
  handle(cmd: Command, host: FakeHost): FakeAck | undefined {
    switch (cmd.name) {
      case 'profile.get': {
        const profile = this.find(cmd.profileId);
        if (profile === undefined) return this.notFound(cmd.profileId);
        return {
          ok: true,
          result: { profile, issues: this.issuesOf(profile), entryCount: this.entryCounts[profile.id] ?? 0 },
        };
      }
      case 'profile.validate':
        return { ok: true, result: { issues: demoProfileIssues(cmd.profile) } };
      case 'profile.save': {
        const issues = demoProfileIssues(cmd.profile);
        const count = issues.filter((finding) => finding.level === 'error').length;
        if (count > 0) return { ok: false, error: makeError('PROFILE_INVALID', { count }) };
        const saved = this.save(cmd.profile);
        if (saved === null) return this.notFound(cmd.profile.id ?? STANDARD_PROFILE_ID);
        this.publish(host);
        return { ok: true, result: { profileId: saved.id } };
      }
      case 'profile.setDefault': {
        const profile = this.find(cmd.profileId);
        if (profile === undefined) return this.notFound(cmd.profileId);
        if (this.issuesOf(profile).some((finding) => finding.level === 'error')) {
          return { ok: false, error: makeError('PROFILE_INVALID', { count: 1 }) };
        }
        this.profiles = this.profiles.map((candidate) => ({ ...candidate, isDefault: candidate.id === cmd.profileId }));
        this.publish(host);
        return { ok: true, result: {} };
      }
      case 'profile.delete': {
        const profile = this.find(cmd.profileId);
        if (profile === undefined) return this.notFound(cmd.profileId);
        if (profile.builtin) return { ok: false, error: makeError('PROFILE_NOT_DELETABLE', { profileId: profile.id }) };
        const count = this.entryCounts[profile.id] ?? 0;
        if (count > 0) return { ok: false, error: makeError('PROFILE_IN_USE', { count }) };
        this.profiles = this.profiles.filter((candidate) => candidate.id !== profile.id);
        if (profile.isDefault) {
          this.profiles = this.profiles.map((candidate) => ({ ...candidate, isDefault: candidate.builtin }));
        }
        this.publish(host);
        return { ok: true, result: {} };
      }
      case 'profile.test': {
        const profile = this.find(cmd.profileId);
        if (profile === undefined) return this.notFound(cmd.profileId);
        const claude = {
          ...(this.options.testResults?.[profile.id] ?? this.claude[profile.id] ?? sampleClaudeInstallStatus()),
          checkedAt: sampleTime(5),
        };
        this.claude[profile.id] = claude;
        this.publish(host);
        return { ok: true, result: { claude } };
      }
      default:
        return undefined;
    }
  }

  private find(id: ProfileId): Profile | undefined {
    return this.profiles.find((profile) => profile.id === id);
  }

  private notFound(profileId: ProfileId): FakeAck {
    return { ok: false, error: makeError('PROFILE_NOT_FOUND', { profileId }) };
  }

  private save(input: ProfileInput): Profile | null {
    const existing = input.id === undefined ? undefined : this.find(input.id);
    if (input.id !== undefined && existing === undefined) return null;
    const saved: Profile = {
      id: existing?.id ?? sampleId('pf', this.next++),
      name: input.name,
      color: input.color,
      isDefault: existing?.isDefault ?? false,
      builtin: existing?.builtin ?? false,
      executable: input.executable,
      configDir: input.configDir,
      env: { ...input.env },
      contextWindow: input.contextWindow,
      args: [...input.args],
      passRawArgs: input.passRawArgs,
      defaults: { ...input.defaults },
      createdAt: existing?.createdAt ?? sampleTime(9),
      updatedAt: sampleTime(10),
    };
    this.profiles = existing === undefined ? [...this.profiles, saved] : this.profiles.map((p) => (p.id === saved.id ? saved : p));
    return saved;
  }

  private publish(host: FakeHost): void {
    host.setHostState(this.hostState(host.hostState));
  }
}

// ---- demo data ----

export const DEMO_PROFILE_IDS = {
  work: sampleId('pf', 2),
  gateway: sampleId('pf', 3),
  broken: sampleId('pf', 4),
} as const;

/** Standard (default, in use) + Work (secrets, config folder, in use) + Gateway (findings) + Broken (error). */
export function demoProfiles(): Profile[] {
  return [
    sampleProfile(),
    sampleProfile({
      id: DEMO_PROFILE_IDS.work,
      name: 'Work',
      color: 'blue',
      isDefault: false,
      builtin: false,
      configDir: 'C:\\Users\\user\\.claude-work',
      env: {
        ANTHROPIC_API_KEY: 'sk-demo-not-a-real-key',
        HTTPS_PROXY: 'http://proxy.example.invalid:8080',
        GITHUB_TOKEN: 'ghp_demo_value',
      },
      args: ['--add-dir', 'D:\\shared'],
      defaults: { model: 'opus', permissionMode: 'plan', effort: 'high' },
    }),
    sampleProfile({
      id: DEMO_PROFILE_IDS.gateway,
      name: 'Gateway',
      color: 'violet',
      isDefault: false,
      builtin: false,
      env: { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid', ANTHROPIC_AUTH_TOKEN: '${env:GATEWAY_TOKEN}' },
      contextWindow: 400_000,
      args: ['--dangerously-skip-permissions', '--verbose', '--add-dir'],
      passRawArgs: true,
      defaults: { model: 'gateway-model-1', permissionMode: null, effort: null },
    }),
    sampleProfile({
      id: DEMO_PROFILE_IDS.broken,
      name: 'Broken',
      color: 'red',
      isDefault: false,
      builtin: false,
      executable: { kind: 'path', path: 'C:\\tools\\missing\\claude.exe' },
      args: ['--resume', 'abc'],
    }),
  ];
}

export interface ProfilesDemoOptions {
  server?: FakeProfileServerOptions;
  hostState?: Partial<HostState>;
  summaries?: readonly SessionSummary[];
  /** Ops are applied right away instead of once per animation frame (tests). */
  immediate?: boolean;
  /** Extra command handling before the profile server (tests: failures). */
  onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined;
}

export interface ProfilesDemo extends NewSessionDemo {
  server: FakeProfileServer;
}

/**
 * Starts the fake host (`startNewSessionDemo`: host `local`, same code path as the app, folder
 * tree) with the profile server answering `profile.*`.
 */
export function startProfilesDemo(options: ProfilesDemoOptions = {}): ProfilesDemo {
  const server = new FakeProfileServer(
    options.server ?? {
      profiles: demoProfiles(),
      entryCounts: { [STANDARD_PROFILE_ID]: 3, [DEMO_PROFILE_IDS.work]: 2 },
    },
  );
  const demo = startNewSessionDemo({
    hostState: server.hostState(sampleHostState(options.hostState)),
    summaries: options.summaries,
    immediate: options.immediate,
    onCommand: (cmd, fake) => options.onCommand?.(cmd, fake) ?? server.handle(cmd, fake),
  });
  return { ...demo, server };
}
