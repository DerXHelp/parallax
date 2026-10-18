import { describe, expect, it } from 'vitest';
import type { SlashCommandInfo } from '@shared/model';
import {
  applyMenuEntry,
  buildMenuEntries,
  classifySlash,
  filterMenu,
  NATIVE_COMMANDS,
  parseSlashDraft,
  slashQuery,
  terminalCommands,
  type DescribeNative,
  type SlashCatalog,
} from './slash';

const describeNative: DescribeNative = (command) => ({
  description: `native ${command}`,
  argumentHint: command === 'model' ? '[model]' : '',
});

/** `supportedCommands()` entries as the CLI reports them (F.12). */
function info(name: string, p: Partial<SlashCommandInfo> = {}): SlashCommandInfo {
  return { name, description: `${name} description`, argumentHint: '', aliases: [], builtin: true, ...p };
}

const CATALOG: SlashCatalog = {
  commands: [
    info('clear', { aliases: ['reset', 'new'], description: 'Clear the conversation' }),
    info('compact', { argumentHint: '<instructions>', description: 'Summarize the conversation' }),
    info('model', { aliases: ['m'] }),
    info('vim'),
    info('review-pr', { builtin: false, description: 'Review a pull request' }),
    info('mcp__github__issue', { builtin: false, description: 'Create an issue' }),
    info('config', { argumentHint: 'key=value', aliases: ['settings'] }),
    info('statusline-x', { builtin: false }),
  ],
  slashCommands: [],
  terminalSlashCommands: ['statusline-x'],
};

function entries(catalog: SlashCatalog = CATALOG) {
  return buildMenuEntries(catalog, describeNative);
}

describe('buildMenuEntries', () => {
  it('lists the native commands first, then the catalog without terminal-only commands', () => {
    const names = entries().map((entry) => entry.name);
    expect(names.slice(0, NATIVE_COMMANDS.length)).toEqual([...NATIVE_COMMANDS]);
    expect(names.slice(NATIVE_COMMANDS.length)).toEqual([
      'clear',
      'compact',
      'review-pr',
      'mcp__github__issue',
      'config',
    ]);
    // Static list (vim) and the CLI's terminal list (statusline-x) are hidden.
    expect(names).not.toContain('vim');
    expect(names).not.toContain('statusline-x');
  });

  it('marks the origin: Parallax, Claude Code, skill/command, MCP', () => {
    const kinds = Object.fromEntries(entries().map((entry) => [entry.name, entry.kind]));
    expect(kinds).toMatchObject({
      model: 'native',
      clear: 'builtin',
      'review-pr': 'custom',
      mcp__github__issue: 'mcp',
    });
  });

  it('merges a catalog entry with a native name into the native one (aliases kept)', () => {
    const model = entries().find((entry) => entry.name === 'model');
    expect(model).toMatchObject({ native: 'model', description: 'native model', aliases: ['m'] });
    expect(entries().filter((entry) => entry.name === 'model')).toHaveLength(1);
  });

  it('without a catalog: only the names of init.slashCommands', () => {
    const list = entries({
      commands: null,
      slashCommands: ['clear', '/compact', 'mcp__x__y'],
      terminalSlashCommands: [],
    });
    expect(
      list.slice(NATIVE_COMMANDS.length).map((entry) => [entry.name, entry.kind, entry.description]),
    ).toEqual([
      ['clear', 'plain', ''],
      ['compact', 'plain', ''],
      ['mcp__x__y', 'mcp', ''],
    ]);
  });
});

describe('filterMenu', () => {
  it('matches name, aliases and description fuzzily, best first', () => {
    const list = entries();
    expect(filterMenu(list, 'comp')[0]?.name).toBe('compact');
    expect(filterMenu(list, 'reset').map((entry) => entry.name)).toContain('clear');
    expect(filterMenu(list, 'pull request')[0]?.name).toBe('review-pr');
    expect(filterMenu(list, '').length).toBe(list.length);
    expect(filterMenu(list, 'zzzz')).toEqual([]);
  });
});

describe('slashQuery', () => {
  it.each([
    ['/mo', 3, 'mo'],
    ['/', 1, ''],
    ['/model haiku', 4, 'model'],
    ['/model haiku', 6, 'model'],
    ['/model haiku', 7, null],
    ['/model', 0, null],
    ['hello /model', 8, null],
    ['', 0, null],
  ] as const)('%j with the caret at %i → %j', (text, caret, query) => {
    expect(slashQuery(text, caret)).toBe(query);
  });
});

describe('applyMenuEntry', () => {
  it('replaces the command word and keeps the arguments', () => {
    expect(applyMenuEntry('/mo', 'model')).toEqual({ text: '/model ', caret: 7 });
    expect(applyMenuEntry('/mo haiku', 'model')).toEqual({ text: '/model haiku', caret: 7 });
  });
});

describe('parseSlashDraft', () => {
  it('splits command and argument (case-insensitive name)', () => {
    expect(parseSlashDraft('/Model  sonnet ')).toEqual({ name: 'model', args: 'sonnet' });
    expect(parseSlashDraft('/plan first line\nsecond')).toEqual({ name: 'plan', args: 'first line\nsecond' });
    expect(parseSlashDraft('/')).toBeNull();
    expect(parseSlashDraft('no command')).toBeNull();
  });
});

describe('classifySlash (WP-37 §2/§3)', () => {
  const list = entries();
  const terminal = terminalCommands(CATALOG.terminalSlashCommands);

  it.each([
    ['/model', { kind: 'native', command: 'model', args: '' }],
    ['/m opus', { kind: 'native', command: 'model', args: 'opus' }],
    ['/effort high', { kind: 'native', command: 'effort', args: 'high' }],
    ['/fast on', { kind: 'native', command: 'fast', args: 'on' }],
    ['/plan write tests first', { kind: 'native', command: 'plan', args: 'write tests first' }],
    ['/rename Better name', { kind: 'native', command: 'rename', args: 'Better name' }],
    ['/status', { kind: 'native', command: 'status', args: '' }],
    ['/resume', { kind: 'native', command: 'resume', args: '' }],
    ['/help', { kind: 'native', command: 'help', args: '' }],
    ['/clear', { kind: 'pass', text: '/clear' }],
    ['/reset', { kind: 'pass', text: '/clear' }],
    ['/new my topic', { kind: 'pass', text: '/clear my topic' }],
    ['/compact keep the API notes', { kind: 'pass', text: '/compact keep the API notes' }],
    ['/vim', { kind: 'terminal', name: 'vim' }],
    ['/statusline-x', { kind: 'terminal', name: 'statusline-x' }],
    ['/permissions', { kind: 'terminal', name: 'permissions' }],
    ['/config', { kind: 'terminal', name: 'config' }],
    ['/config theme', { kind: 'terminal', name: 'config' }],
    ['/config theme=dark', { kind: 'pass', text: '/config theme=dark' }],
    // An alias of /config follows the same rule (terminal without key=value).
    ['/settings', { kind: 'terminal', name: 'settings' }],
    ['/settings theme=dark', { kind: 'pass', text: '/config theme=dark' }],
    ['/unknown-skill arg', { kind: 'pass', text: '/unknown-skill arg' }],
    ['/mcp__github__issue Bug', { kind: 'pass', text: '/mcp__github__issue Bug' }],
  ] as const)('%j', (text, action) => {
    expect(classifySlash(text, list, terminal)).toEqual(action);
  });

  it('`/` alone is no command', () => {
    expect(classifySlash('/', list, terminal)).toBeNull();
  });
});
