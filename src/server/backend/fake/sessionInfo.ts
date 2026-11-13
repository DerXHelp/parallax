/**
 * WP-67: the session info of the FakeBackend – raw answers in the CLI's shapes (claude 2.1.323:
 * `get_status`, `get_memory_dialog`, `get_skills_dialog`, `get_hooks_listing`,
 * `list_permission_rules`, `mcpServerStatus`, `export_conversation`) that run through the same
 * parser as the SdkBackend (`backend/sessionInfo.ts`), plus the MCP actions and the reloads. No
 * account data anywhere (no e-mail, no organisation). One state per session (each CLI process has
 * its own MCP connections): `fake-docs` connected, `fake-search` failed, `fake-auth` needs-auth,
 * `fake-off` disabled; "reconnect" connects a failed server, a disabled one refuses; enable/disable
 * switch it; `reloadSkills()` adds `fresh-skill`.
 * Levers: `FakeBackendOptions.sessionInfo` (tests) and the keywords `fake:info-unavailable
 * [section …]`, `fake:info-fail`, `fake:info-long` and `fake:info-reset` (dev, E2E; interactive.ts).
 */
import { z } from 'zod';
import {
  SESSION_INFO_SECTIONS,
  sessionInfoSectionNameSchema,
  type McpAction,
  type ReloadTarget,
  type SessionInfoSectionName,
} from '@shared/model';
import { FAKE_CLAUDE_VERSION } from './defaults';
import type { DslContext } from './dsl';
import { answerTurn, type Turn } from './turn';
import type { FakeScriptContext, FakeSessionInfoOptions } from './types';

/** The fake user's home (never a real account name). */
export const FAKE_INFO_HOME = 'C:\\Users\\fake-user';
/** The skill `reloadSkills()` adds (E2E: "Reload skills" shows it). */
export const FAKE_FRESH_SKILL = 'fresh-skill';
/** Error text of the actions with the 'failed' lever (like a CLI that refuses). */
export const FAKE_INFO_ACTION_ERROR = 'Fake: the CLI refused the request';

const LONG_SKILLS = 1200;
const LONG_RULES = 240;
const LONG_SERVERS = 60;
const LONG_HOOKS = 120;
const LONG_EXPORT_LINES = 20_000;

type FakeMcpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';

interface FakeMcpServer {
  name: string;
  status: FakeMcpStatus;
  error: string | null;
  scope: string;
  transport: string;
  version: string | null;
  tools: readonly string[];
}

const BASE_SERVERS: readonly FakeMcpServer[] = [
  {
    name: 'fake-docs',
    status: 'connected',
    error: null,
    scope: 'user',
    transport: 'stdio',
    version: '1.4.0',
    tools: ['search_docs', 'read_page'],
  },
  {
    name: 'fake-search',
    status: 'failed',
    error: 'Connection closed: spawn fake-search ENOENT',
    scope: 'project',
    transport: 'stdio',
    version: null,
    tools: [],
  },
  {
    name: 'fake-auth',
    status: 'needs-auth',
    error: null,
    scope: 'user',
    transport: 'http',
    version: null,
    tools: [],
  },
  {
    name: 'fake-off',
    status: 'disabled',
    error: null,
    scope: 'local',
    transport: 'sse',
    version: null,
    tools: [],
  },
];

interface FakeSkill {
  name: string;
  display_name: string;
  description: string;
  source: string;
  tokens: number;
  state: 'on' | 'name-only' | 'user-invocable-only' | 'off';
  locked_by?: 'author' | 'plugin' | 'policy' | 'flag' | 'reserved-name';
}

const BASE_SKILLS: readonly FakeSkill[] = [
  {
    name: 'review',
    display_name: 'review',
    description: 'Review the current diff',
    source: 'built-in',
    tokens: 120,
    state: 'on',
  },
  {
    name: 'release-notes',
    display_name: 'release-notes',
    description: 'Draft release notes from the git log',
    source: 'user',
    tokens: 340,
    state: 'on',
  },
  {
    name: 'db-migrate',
    display_name: 'db-migrate',
    description: 'Create a database migration',
    source: 'project',
    tokens: 910,
    state: 'name-only',
  },
  {
    name: 'fake-plugin:lint',
    display_name: 'lint (fake-plugin)',
    description: 'Run the plugin linter',
    source: 'plugin',
    tokens: 60,
    state: 'on',
    locked_by: 'plugin',
  },
  {
    name: 'deploy',
    display_name: 'deploy',
    description: 'Deploy to production',
    source: 'project',
    tokens: 450,
    state: 'user-invocable-only',
    locked_by: 'author',
  },
  {
    name: 'old-helper',
    display_name: 'old-helper',
    description: 'Turned off by a managed setting',
    source: 'user',
    tokens: 75,
    state: 'off',
    locked_by: 'policy',
  },
];

const FRESH_SKILL: FakeSkill = {
  name: FAKE_FRESH_SKILL,
  display_name: FAKE_FRESH_SKILL,
  description: 'A skill that appeared after "Reload skills"',
  source: 'project',
  tokens: 200,
  state: 'on',
};

const HOOK_EVENTS = [
  { name: 'PreToolUse', summary: 'Before a tool runs', supportsMatcher: true },
  { name: 'PostToolUse', summary: 'After a tool ran', supportsMatcher: true },
  { name: 'SessionStart', summary: 'When a session starts or resumes', supportsMatcher: true },
  { name: 'Stop', summary: 'When Claude finishes answering', supportsMatcher: false },
] as const;

/** What the answers need from the session (no account data). */
export interface FakeInfoView {
  sessionId: string | null;
  cwd: string;
  model: string;
  permissionMode: string;
  now: Date;
  /** The session's transcript (raw SDK messages of the fake history) for the export. */
  messages: readonly unknown[];
}

const textBlockSchema = z.looseObject({ type: z.literal('text'), text: z.string() });
const transcriptMessageSchema = z.looseObject({
  type: z.enum(['user', 'assistant']),
  message: z.looseObject({ content: z.union([z.string(), z.array(z.unknown())]) }),
});

/** User and assistant texts of the transcript, in order (tool results and the rest left out). */
function transcriptTexts(messages: readonly unknown[]): { role: 'user' | 'assistant'; text: string }[] {
  const out: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const raw of messages) {
    const parsed = transcriptMessageSchema.safeParse(raw);
    if (!parsed.success) continue;
    const content = parsed.data.message.content;
    const text =
      typeof content === 'string'
        ? content
        : content
            .flatMap((block) => {
              const b = textBlockSchema.safeParse(block);
              return b.success ? [b.data.text] : [];
            })
            .join('\n');
    if (text.trim() !== '') out.push({ role: parsed.data.type, text });
  }
  return out;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Like the CLI's /export name: local time and the first prompt (`2026-11-13-101500-fix-login.txt`). */
function cliExportName(now: Date, firstPrompt: string | undefined): string {
  const stamp = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = (firstPrompt ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug === '' ? `${stamp}.txt` : `${stamp}-${slug}.txt`;
}

function sectionsOf(value: FakeSessionInfoOptions['unavailable']): Set<SessionInfoSectionName> {
  if (value === undefined) return new Set();
  return new Set(value === 'all' ? SESSION_INFO_SECTIONS : value);
}

/** The session info state of one fake session. */
export class FakeSessionInfo {
  private unavailable = new Set<SessionInfoSectionName>();
  private actions: 'ok' | 'failed' = 'ok';
  private long = false;
  private servers: FakeMcpServer[] = [];
  private skillsReloaded = false;
  private pluginReloads = 0;

  constructor(private readonly options: FakeSessionInfoOptions) {
    this.reset();
  }

  /** Back to the backend options (`fake:info-reset`). */
  reset(): void {
    this.unavailable = sectionsOf(this.options.unavailable);
    this.actions = this.options.actions ?? 'ok';
    this.long = this.options.long ?? false;
    this.servers = BASE_SERVERS.map((server) => ({ ...server }));
    this.skillsReloaded = false;
    this.pluginReloads = 0;
  }

  /** `fake:info-unavailable [section …]`: without sections every one. */
  setUnavailable(sections: readonly SessionInfoSectionName[] | 'all'): void {
    for (const section of sectionsOf(sections)) this.unavailable.add(section);
  }

  /** `fake:info-fail`: MCP actions and reloads fail. */
  failActions(): void {
    this.actions = 'failed';
  }

  /** `fake:info-long`: long lists (skills beyond the list cap, many rules, servers, hooks, export lines). */
  useLongLists(): void {
    this.long = true;
  }

  /** false = the method is missing in this (fake) CLI. */
  available(section: SessionInfoSectionName): boolean {
    return !this.unavailable.has(section);
  }

  /** The raw CLI answer of one section. */
  answer(section: SessionInfoSectionName, view: FakeInfoView): unknown {
    switch (section) {
      case 'status':
        return this.status(view);
      case 'memory':
        return memory(view);
      case 'skills':
        return { skills: this.skills() };
      case 'hooks':
        return this.hooks(view);
      case 'permissions':
        return { state: this.permissions(view) };
      case 'mcp':
        return this.mcp();
      case 'export':
        return this.export(view);
    }
  }

  /** reconnectMcpServer / toggleMcpServer like the CLI: rejects with the CLI's error text. */
  mcpAction(name: string, action: McpAction): void {
    if (this.actions === 'failed') throw new Error(FAKE_INFO_ACTION_ERROR);
    const server = this.servers.find((s) => s.name === name);
    if (server === undefined) throw new Error(`MCP server not found: ${name}`);
    if (action === 'reconnect') {
      if (server.status === 'disabled') throw new Error(`MCP server "${name}" is disabled`);
      if (server.status !== 'needs-auth') {
        server.status = 'connected';
        server.error = null;
        if (server.tools.length === 0) server.tools = ['ping'];
      }
      return;
    }
    if (action === 'disable') {
      server.status = 'disabled';
      server.error = null;
      return;
    }
    if (server.status === 'disabled')
      server.status = server.transport === 'http' ? 'needs-auth' : 'connected';
  }

  /** reloadSkills / reloadPlugins: the raw answer (the engine only needs that it resolved). */
  reload(what: ReloadTarget): unknown {
    if (this.actions === 'failed') throw new Error(FAKE_INFO_ACTION_ERROR);
    if (what === 'skills') {
      this.skillsReloaded = true;
      return {
        skills: this.skills().map((s) => ({ name: s.name, description: s.description, argumentHint: '' })),
      };
    }
    this.pluginReloads += 1;
    return { commands: [], agents: [], plugins: [], mcpServers: [], error_count: 0 };
  }

  private status(view: FakeInfoView): unknown {
    const connected = this.servers.filter((s) => s.status === 'connected').length;
    const failed = this.servers.filter((s) => s.status === 'failed').length;
    return {
      sections: [
        {
          title: 'Session',
          rows: [
            { label: 'Version', value: `${FAKE_CLAUDE_VERSION} (fake)` },
            { label: 'Session ID', value: view.sessionId ?? '-' },
            { label: 'cwd', value: view.cwd },
          ],
        },
        {
          title: 'Environment',
          rows: [
            { label: 'Model', value: view.model },
            { label: 'Permission mode', value: view.permissionMode },
            { label: 'MCP servers', value: `${String(connected)} connected, ${String(failed)} failed` },
            { label: 'Memory', value: 'user (CLAUDE.md), project (CLAUDE.md)' },
            { label: 'Setting sources', value: 'User settings, Project settings, Local settings' },
          ],
        },
        { title: 'Internal', rows: [{ value: `Plugin reloads: ${String(this.pluginReloads)}` }] },
      ],
    };
  }

  private skills(): FakeSkill[] {
    const list = [...BASE_SKILLS, ...(this.skillsReloaded ? [FRESH_SKILL] : [])];
    if (!this.long) return list;
    for (let i = 1; i <= LONG_SKILLS; i += 1) {
      const name = `generated-skill-${pad(i, 4)}`;
      list.push({
        name,
        display_name: name,
        description: `Generated skill ${String(i)}`,
        source: 'user',
        tokens: (i * 37) % 1500,
        state: 'on',
      });
    }
    return list;
  }

  private hooks(view: FakeInfoView): unknown {
    const hooks: Record<string, unknown>[] = [
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        source: 'userSettings',
        sourceLabel: 'User settings',
        type: 'command',
        displayText: `node ${FAKE_INFO_HOME}\\.claude\\hooks\\guard.mjs`,
        commandText: `node ${FAKE_INFO_HOME}\\.claude\\hooks\\guard.mjs`,
        contentLabel: 'Command',
        timeout: 30,
        statusMessage: 'Checking the command…',
      },
      {
        event: 'PreToolUse',
        matcher: 'Edit|Write',
        source: 'projectSettings',
        sourceLabel: 'Project settings',
        type: 'command',
        displayText: 'pnpm exec prettier --check',
        commandText: 'pnpm exec prettier --check',
        contentLabel: 'Command',
        condition: 'Edit(src/**)',
      },
      {
        event: 'PostToolUse',
        matcher: '',
        source: 'pluginHook',
        sourceLabel: 'Plugin',
        pluginName: 'fake-plugin',
        type: 'command',
        displayText: 'fake-plugin notify',
        commandText: 'fake-plugin notify',
        contentLabel: 'Command',
        runsInBackground: true,
      },
      {
        event: 'SessionStart',
        matcher: 'startup',
        source: 'localSettings',
        sourceLabel: 'Local settings',
        type: 'command',
        displayText: `type "${view.cwd}\\NOTES.md"`,
        commandText: `type "${view.cwd}\\NOTES.md"`,
        contentLabel: 'Command',
        runsOnce: true,
        disabled: true,
      },
    ];
    if (this.long) {
      for (let i = 1; i <= LONG_HOOKS; i += 1) {
        hooks.push({
          event: 'PostToolUse',
          matcher: `Tool${String(i)}`,
          source: 'userSettings',
          sourceLabel: 'User settings',
          type: 'command',
          displayText: `echo generated hook ${String(i)}`,
          commandText: `echo generated hook ${String(i)}`,
          contentLabel: 'Command',
        });
      }
    }
    return {
      events: HOOK_EVENTS.map((event) => ({
        ...event,
        hookCount: hooks.filter((hook) => hook.event === event.name).length,
      })),
      hooks,
      eventCatalog: HOOK_EVENTS.map((event) => ({ ...event })),
      policy: {
        disabledByPolicy: false,
        managedOnly: false,
        pluginOnly: false,
        allDisabled: false,
        policyHookCount: 0,
      },
    };
  }

  private permissions(view: FakeInfoView): unknown {
    const rules: Record<string, unknown>[] = [
      {
        behavior: 'allow',
        source: 'userSettings',
        rule: 'Bash(git status:*)',
        editability: 'persistent',
        description: { prefix: 'Run ', emphasis: 'git status', suffix: ' with any arguments' },
      },
      { behavior: 'allow', source: 'projectSettings', rule: 'Read(src/**)', editability: 'persistent' },
      { behavior: 'allow', source: 'session', rule: 'WebFetch(domain:example.com)', editability: 'session' },
      { behavior: 'ask', source: 'localSettings', rule: 'Bash(git push:*)', editability: 'persistent' },
      { behavior: 'deny', source: 'policySettings', rule: 'Bash(rm -rf:*)', editability: 'readonly' },
      {
        behavior: 'deny',
        source: 'projectSettings',
        rule: 'Read(.env)',
        editability: 'persistent',
        notInEffect: true,
      },
    ];
    if (this.long) {
      for (let i = 1; i <= LONG_RULES; i += 1) {
        rules.push({
          behavior: i % 3 === 0 ? 'deny' : 'allow',
          source: 'userSettings',
          rule: `Bash(tool-${String(i)}:*)`,
          editability: 'persistent',
        });
      }
    }
    return {
      rules,
      workspaceDirectories: [
        { path: view.cwd, source: 'cwd' },
        { path: `${FAKE_INFO_HOME}\\shared-libs`, source: 'userSettings' },
      ],
      originalCwd: view.cwd,
      managedOnly: false,
    };
  }

  private mcp(): unknown {
    const servers = [...this.servers];
    if (this.long) {
      for (let i = 1; i <= LONG_SERVERS; i += 1) {
        servers.push({
          name: `generated-${pad(i, 3)}`,
          status: 'connected',
          error: null,
          scope: 'user',
          transport: 'stdio',
          version: '0.1.0',
          tools: ['tool'],
        });
      }
    }
    return servers.map((server) => ({
      name: server.name,
      status: server.status,
      ...(server.error === null ? {} : { error: server.error }),
      scope: server.scope,
      config: { type: server.transport },
      ...(server.version === null ? {} : { serverInfo: { name: server.name, version: server.version } }),
      tools: server.tools.map((name) => ({ name })),
    }));
  }

  private export(view: FakeInfoView): unknown {
    const texts = transcriptTexts(view.messages);
    const lines = [`Claude Code (fake) v${FAKE_CLAUDE_VERSION}`, `cwd: ${view.cwd}`, ''];
    for (const { role, text } of texts) {
      lines.push(role === 'user' ? `> ${text}` : `⏺ ${text}`, '');
    }
    if (this.long) {
      for (let i = 1; i <= LONG_EXPORT_LINES; i += 1) lines.push(`Generated export line ${String(i)}`);
    }
    return {
      text: lines.join('\n'),
      default_filename: cliExportName(view.now, texts.find((t) => t.role === 'user')?.text),
    };
  }
}

function memory(view: FakeInfoView): unknown {
  const now = view.now.getTime();
  const autoFolder = `${FAKE_INFO_HOME}\\.claude\\projects\\fake-project\\memory`;
  return {
    files: [
      {
        kind: 'user',
        path: `${FAKE_INFO_HOME}\\.claude\\CLAUDE.md`,
        label: 'User memory',
        description: 'Saved in ~/.claude/CLAUDE.md',
        exists: true,
      },
      {
        kind: 'project',
        path: `${view.cwd}\\CLAUDE.md`,
        label: 'Project memory',
        description: 'Checked in at ./CLAUDE.md',
        exists: true,
      },
      {
        kind: 'project-alt',
        path: `${view.cwd}\\.claude\\CLAUDE.md`,
        label: 'Project memory (alternative)',
        description: './.claude/CLAUDE.md',
        exists: false,
      },
      {
        kind: 'local',
        path: `${view.cwd}\\CLAUDE.local.md`,
        label: 'Local memory',
        description: 'Not checked in',
        exists: false,
      },
    ],
    folders: [
      {
        kind: 'auto',
        path: autoFolder,
        label: 'Auto memory',
        description: 'Notes Claude keeps for this project',
      },
    ],
    memories: [
      {
        name: 'build-commands',
        path: `${autoFolder}\\build-commands.md`,
        description: 'How to build and test',
        type: 'project',
        modified_ms: now - 3_600_000,
      },
      {
        name: 'review-style',
        path: `${autoFolder}\\review-style.md`,
        description: null,
        type: 'feedback',
        modified_ms: now - 86_400_000,
      },
    ],
    auto_memory: { enabled: true, toggleable: true, status: 'On' },
    auto_dream: { shown: false, enabled: false, toggleable: false, status: 'Off', detail: '' },
  };
}

// ---- keywords (interactive.ts) ----

export const FAKE_INFO_KEYWORDS = [
  'fake:info-unavailable',
  'fake:info-fail',
  'fake:info-long',
  'fake:info-reset',
] as const;
export type FakeInfoKeyword = (typeof FAKE_INFO_KEYWORDS)[number];

export function isFakeInfoKeyword(keyword: string): keyword is FakeInfoKeyword {
  return (FAKE_INFO_KEYWORDS as readonly string[]).includes(keyword);
}

/** Sections named after the keyword (unknown words ignored); none = every section. */
function namedSections(text: string): SessionInfoSectionName[] | 'all' {
  const named = text
    .split(/\s+/)
    .slice(1)
    .flatMap((word) => {
      const parsed = sessionInfoSectionNameSchema.safeParse(word.toLowerCase());
      return parsed.success ? [parsed.data] : [];
    });
  return named.length === 0 ? 'all' : named;
}

/** A `fake:info-*` keyword: switches the lever of this session and answers with a short turn. */
export async function infoKeyword(
  ctx: FakeScriptContext,
  c: DslContext,
  turn: Turn,
  keyword: FakeInfoKeyword,
  text: string,
): Promise<void> {
  let answer: string;
  switch (keyword) {
    case 'fake:info-unavailable': {
      const sections = namedSections(text);
      ctx.info.setUnavailable(sections);
      answer = `Fake: session info unavailable (${sections === 'all' ? 'all sections' : sections.join(', ')}).`;
      break;
    }
    case 'fake:info-fail':
      ctx.info.failActions();
      answer = 'Fake: MCP actions and reloads fail from now on.';
      break;
    case 'fake:info-long':
      ctx.info.useLongLists();
      answer = 'Fake: the session info shows long lists.';
      break;
    case 'fake:info-reset':
      ctx.info.reset();
      answer = 'Fake: session info back to normal.';
      break;
  }
  await answerTurn(ctx, c, turn, answer);
}
