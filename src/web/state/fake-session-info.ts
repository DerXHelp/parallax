import type { EntryId } from '@shared/common';
import type {
  McpAction,
  ReloadTarget,
  SessionInfoOf,
  SessionInfoSection,
  SessionInfoSectionName,
  SessionSummary,
} from '@shared/model';

/**
 * Session info of the web fake host (WP-67; playground and web tests): display-ready answers of
 * `session.info` for every tab – synthetic, without any account data – and the MCP/reload actions
 * as a small state machine per entry. Levers: `unavailable` (sections a "CLI" lacks), `actionError`
 * (actions fail with CLAUDE_CONTROL_FAILED and this text), `long` (long lists).
 * Dev/test only – never imported by production code.
 */

/** Names of the fake MCP servers (connected, failed, needs-auth, disabled). */
export const FAKE_MCP = {
  docs: 'fake-docs',
  search: 'fake-search',
  auth: 'fake-auth',
  off: 'fake-off',
} as const;
/** The skill that appears after "Reload skills". */
export const FAKE_INFO_FRESH_SKILL = 'fresh-skill';
/** Error text of a failed fake MCP action or reload. */
export const FAKE_INFO_ACTION_ERROR = 'Fake: the CLI refused the request';

const HOME = 'C:\\Users\\user';
const SEARCH_ERROR = 'Connection closed: spawn fake-search ENOENT';

type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
type McpServer = SessionInfoOf<'mcp'>['servers'][number];

interface EntryInfo {
  mcp: Map<string, McpStatus>;
  skillsReloaded: boolean;
  pluginsReloaded: number;
}

function initialMcp(): Map<string, McpStatus> {
  return new Map<string, McpStatus>([
    [FAKE_MCP.docs, 'connected'],
    [FAKE_MCP.search, 'failed'],
    [FAKE_MCP.auth, 'needs-auth'],
    [FAKE_MCP.off, 'disabled'],
  ]);
}

function server(name: string, status: McpStatus): McpServer {
  return {
    name,
    status,
    error: status === 'failed' ? SEARCH_ERROR : null,
    scope: name === FAKE_MCP.auth ? 'user' : 'project',
    source: name === FAKE_MCP.auth ? 'user' : 'project',
    transport: name === FAKE_MCP.auth ? 'http' : 'stdio',
    serverVersion: status === 'connected' ? `${name} 1.0.0` : null,
    tools: status === 'connected' ? [`mcp__${name}__lookup`, `mcp__${name}__list`] : [],
  };
}

export class FakeSessionInfoData {
  /** Sections the fake CLI lacks (`available: false`); 'all' = every section. */
  unavailable: ReadonlySet<SessionInfoSectionName> | 'all' = new Set();
  /** When set, every MCP action and reload fails with CLAUDE_CONTROL_FAILED and this text. */
  actionError: string | null = null;
  /** Long lists (1 200 skills, 240 rules, 60 servers, 120 hooks, a long export). */
  long = false;

  private readonly entries = new Map<EntryId, EntryInfo>();

  private entry(entryId: EntryId): EntryInfo {
    let entry = this.entries.get(entryId);
    if (entry === undefined) {
      entry = { mcp: initialMcp(), skillsReloaded: false, pluginsReloaded: 0 };
      this.entries.set(entryId, entry);
    }
    return entry;
  }

  available(section: SessionInfoSectionName): boolean {
    return this.unavailable !== 'all' && !this.unavailable.has(section);
  }

  /** The answer of one tab; `summary` gives cwd and title (the export's first line). */
  section(entryId: EntryId, section: SessionInfoSectionName, summary: SessionSummary): SessionInfoSection {
    const entry = this.entry(entryId);
    switch (section) {
      case 'mcp':
        return this.mcp(entry);
      case 'skills':
        return this.skills(entry);
      case 'permissions':
        return this.permissions(summary);
      case 'memory':
        return this.memory(summary);
      case 'hooks':
        return this.hooks();
      case 'status':
        return this.status(summary);
      case 'export':
        return this.export(summary);
    }
  }

  /** null = done; else the CLI's error text (the host answers CLAUDE_CONTROL_FAILED). */
  mcpAction(entryId: EntryId, name: string, action: McpAction): string | null {
    if (this.actionError !== null) return this.actionError;
    const mcp = this.entry(entryId).mcp;
    const status = mcp.get(name);
    if (status === undefined) return `MCP server not found: ${name}`;
    if (action === 'disable') mcp.set(name, 'disabled');
    else if (action === 'enable') mcp.set(name, 'connected');
    else if (status === 'disabled') return `MCP server "${name}" is disabled`;
    else mcp.set(name, 'connected');
    return null;
  }

  reload(entryId: EntryId, what: ReloadTarget): string | null {
    if (this.actionError !== null) return this.actionError;
    const entry = this.entry(entryId);
    if (what === 'skills') entry.skillsReloaded = true;
    else entry.pluginsReloaded += 1;
    return null;
  }

  private mcp(entry: EntryInfo): SessionInfoOf<'mcp'> {
    const servers = [...entry.mcp].map(([name, status]) => server(name, status));
    if (this.long)
      for (let i = 0; i < 56; i++) servers.push(server(`fake-extra-${String(i + 1)}`, 'connected'));
    return { section: 'mcp', servers, truncated: false, extra: [] };
  }

  private skills(entry: EntryInfo): SessionInfoOf<'skills'> {
    const skill = (
      name: string,
      source: string,
      tokens: number | null,
      state: string,
      lockedBy: string | null = null,
    ): SessionInfoOf<'skills'>['skills'][number] => ({
      name,
      displayName: name,
      description: `Fake skill ${name}`,
      source,
      tokens,
      state,
      lockedBy,
    });
    const skills = [
      skill('review-pr', 'user', 420, 'on'),
      skill('release-notes', 'project', 180, 'name-only'),
      skill('deploy', 'project', 260, 'user-invocable-only', 'author'),
      skill('docs-lint', 'plugin', 95, 'on', 'plugin'),
      skill('legacy-build', 'project', 310, 'off', 'policy'),
      skill('verify', 'built-in', null, 'on'),
    ];
    if (entry.skillsReloaded) skills.push(skill(FAKE_INFO_FRESH_SKILL, 'project', 120, 'on'));
    if (this.long) {
      const extra = Array.from({ length: 1200 }, (_, i) =>
        skill(`bulk-skill-${String(i + 1)}`, 'plugin', 20 + (i % 50), 'on'),
      );
      skills.push(...extra);
    }
    const truncated = skills.length > 1000;
    return { section: 'skills', skills: skills.slice(0, 1000), truncated, extra: [] };
  }

  private permissions(summary: SessionSummary): SessionInfoOf<'permissions'> {
    type Rule = SessionInfoOf<'permissions'>['rules'][number];
    const rule = (
      behavior: Rule['behavior'],
      source: string,
      text: string,
      description: Rule['description'] = null,
      editability = 'persistent',
    ): Rule => ({ behavior, source, rule: text, description, editability, notInEffect: false });
    const rules: Rule[] = [
      rule('allow', 'userSettings', 'Read', { prefix: 'Reading any file', emphasis: null, suffix: null }),
      rule('allow', 'projectSettings', 'Bash(pnpm run test:*)', {
        prefix: 'Any Bash command starting with',
        emphasis: 'pnpm run test',
        suffix: null,
      }),
      rule('allow', 'session', 'WebFetch(domain:example.com)', null, 'session'),
      rule('ask', 'projectSettings', 'Bash(git push:*)'),
      rule('deny', 'localSettings', 'Bash(rm -rf:*)'),
      rule('deny', 'policySettings', 'Read(./secrets/**)', null, 'readonly'),
    ];
    if (this.long) {
      for (let i = 0; i < 240; i++)
        rules.push(rule('allow', 'projectSettings', `Bash(fake-tool-${String(i + 1)}:*)`));
    }
    return {
      section: 'permissions',
      rules,
      directories: [{ path: `${summary.cwd}\\..\\shared`, source: 'cliArg' }],
      cwd: summary.cwd,
      managedOnly: false,
      errors: [],
      truncated: false,
      extra: [],
    };
  }

  private memory(summary: SessionSummary): SessionInfoOf<'memory'> {
    return {
      section: 'memory',
      files: [
        {
          kind: 'user',
          path: `${HOME}\\.claude\\CLAUDE.md`,
          label: 'User memory',
          description: 'Saved in ~/.claude/CLAUDE.md',
          exists: true,
        },
        {
          kind: 'project',
          path: `${summary.cwd}\\CLAUDE.md`,
          label: 'Project memory',
          description: 'Checked in at ./CLAUDE.md',
          exists: true,
        },
        {
          kind: 'local',
          path: `${summary.cwd}\\CLAUDE.local.md`,
          label: 'Local memory',
          description: 'Not checked in',
          exists: false,
        },
      ],
      folders: [
        {
          kind: 'auto',
          path: `${HOME}\\.claude\\projects\\sample\\memory`,
          label: 'Auto memory folder',
          description: '',
        },
      ],
      memories: [
        {
          name: 'build-rules',
          path: `${HOME}\\.claude\\projects\\sample\\memory\\build-rules.md`,
          description: 'Run the checks one after the other',
          type: 'feedback',
          modifiedAt: summary.lastActivityAt,
        },
      ],
      autoMemory: { enabled: true, toggleable: true, status: 'on' },
      autoDream: { shown: true, enabled: false, toggleable: true, status: 'off', detail: '' },
      truncated: false,
      extra: [],
    };
  }

  private hooks(): SessionInfoOf<'hooks'> {
    type Hook = SessionInfoOf<'hooks'>['hooks'][number];
    const hook = (event: string, matcher: string, command: string, extra: Partial<Hook> = {}): Hook => ({
      event,
      matcher,
      source: 'projectSettings',
      sourceLabel: 'Project settings',
      pluginName: null,
      type: 'command',
      displayText: command,
      command,
      contentLabel: 'Command',
      condition: null,
      timeoutSec: null,
      statusMessage: null,
      once: false,
      background: false,
      disabled: false,
      ...extra,
    });
    const hooks: Hook[] = [
      hook('PreToolUse', 'Bash', 'node scripts/check-command.mjs', { timeoutSec: 10 }),
      hook('PreToolUse', 'Edit|Write', 'pnpm exec prettier --check "$FILE"', {
        source: 'userSettings',
        sourceLabel: 'User settings',
      }),
      hook('PostToolUse', '', 'node scripts/log-tool.mjs', { background: true }),
      hook('SessionStart', '', 'echo ready', {
        once: true,
        source: 'plugin',
        sourceLabel: 'Plugin',
        pluginName: 'fake-tools',
      }),
    ];
    if (this.long)
      for (let i = 0; i < 120; i++)
        hooks.push(hook('PostToolUse', `Tool${String(i + 1)}`, `node hook-${String(i + 1)}.mjs`));
    const events = ['PreToolUse', 'PostToolUse', 'SessionStart'].map((name) => ({
      name,
      summary: `Fake summary of ${name}`,
      matcherSupported: name !== 'SessionStart',
      count: hooks.filter((h) => h.event === name).length,
    }));
    return {
      section: 'hooks',
      events,
      hooks,
      policy: {
        disabledByPolicy: false,
        managedOnly: false,
        pluginOnly: false,
        allDisabled: false,
        policyHookCount: 0,
        policyUnreadable: false,
      },
      safeMode: null,
      bareMode: null,
      errors: [],
      truncated: false,
      extra: [],
    };
  }

  private status(summary: SessionSummary): SessionInfoOf<'status'> {
    return {
      section: 'status',
      groups: [
        {
          title: 'Session',
          rows: [
            { label: 'Session ID', value: summary.sessionId ?? 'not started' },
            { label: 'cwd', value: summary.cwd },
          ],
        },
        {
          title: 'Model',
          rows: [
            { label: 'Model', value: summary.model ?? 'Default' },
            { label: null, value: 'Fake status of the web playground (no account data).' },
          ],
        },
      ],
      extra: [],
    };
  }

  private export(summary: SessionSummary): SessionInfoOf<'export'> {
    const lines = [`> ${summary.title}`, '', '⏺ Fake answer of the web playground.'];
    if (this.long)
      for (let i = 0; i < 20_000; i++) lines.push(`Line ${String(i + 1)} of a long fake conversation.`);
    const text = lines.join('\n');
    return {
      section: 'export',
      text,
      filename: '2026-11-13-101500-fake-conversation.txt',
      totalChars: text.length,
      truncated: false,
    };
  }
}
