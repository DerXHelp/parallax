import type { SlashCommandInfo } from '@shared/model';
import { fuzzyScore } from '@web/lib/fuzzy';

/**
 * Slash commands of the composer (ADR-108, Plan "Slash-Befehle", WP-37): pure helpers for the menu
 * (discovery, fuzzy search) and for sending a `/` draft (native, terminal-only or pass-through).
 */

/** Commands Parallax handles itself (ADR-108); everything else goes to Claude Code as a prompt. */
export const NATIVE_COMMANDS = [
  'model',
  'effort',
  'fast',
  'plan',
  'rename',
  'status',
  'help',
  'resume',
] as const;
export type NativeCommand = (typeof NATIVE_COMMANDS)[number];

/** Native commands without an argument: the menu runs them right away. */
export const NATIVE_WITHOUT_ARGUMENT: ReadonlySet<NativeCommand> = new Set<NativeCommand>([
  'status',
  'help',
  'resume',
]);

/**
 * Commands that only work in the terminal UI of Claude Code (WP-37 §3; Plan category 3): hidden in
 * the menu, typed ones are not sent but offer "Open in an external console". Together with
 * `init.terminalSlashCommands` of the CLI (L1 – the static list is the fallback).
 */
export const TERMINAL_ONLY_COMMANDS = [
  'theme',
  'terminal-setup',
  'tui',
  'vim',
  'keybindings',
  'statusline',
  'ide',
  'desktop',
  'bg',
  'voice',
  'mobile',
  'install-github-app',
  'install-slack-app',
  'upgrade',
  'exit',
  'quit',
  'login',
  'logout',
  'permissions',
  'hooks',
  'memory',
  'plugin',
  'mcp',
  'agents',
  'remote-control',
] as const;

/** `/config` is terminal-only unless it carries a `key=value` argument. */
const CONFIG_COMMAND = 'config';
const KEY_VALUE = /^[^\s=]+=/;

/** Prefix of MCP prompts (`/mcp__server__prompt`). */
const MCP_PREFIX = 'mcp__';

/**
 * Where a menu entry comes from: `native` = Parallax, `builtin` = Claude Code, `custom` = skill or
 * own command, `mcp` = MCP prompt, `plain` = only a name (no catalog yet, `init.slashCommands`).
 */
export type MenuKind = 'native' | 'builtin' | 'custom' | 'mcp' | 'plain';

export interface MenuEntry {
  /** Without the leading slash, as Claude Code lists it. */
  name: string;
  description: string;
  argumentHint: string;
  aliases: readonly string[];
  kind: MenuKind;
  /** Set for the commands Parallax handles itself. */
  native: NativeCommand | null;
}

/** Native commands with an (optional) argument. */
export type NativeWithArgument = Exclude<NativeCommand, 'status' | 'help' | 'resume'>;

export function takesArgument(command: NativeCommand): command is NativeWithArgument {
  return !NATIVE_WITHOUT_ARGUMENT.has(command);
}

/** Translated description and argument hint of a native command (the caller passes `t()` texts). */
export type DescribeNative = (command: NativeCommand) => { description: string; argumentHint: string };

/** What the session reports about its commands (`detail.commands`, `detail.init`). */
export interface SlashCatalog {
  /** `supportedCommands()` (ADR-108/114); null before the first report. */
  commands: readonly SlashCommandInfo[] | null;
  /** `init.slash_commands` (names only). */
  slashCommands: readonly string[];
  /** `init.terminal_slash_commands` (L1). */
  terminalSlashCommands: readonly string[];
}

function bare(name: string): string {
  return (name.startsWith('/') ? name.slice(1) : name).trim().toLowerCase();
}

function catalogKind(info: SlashCommandInfo): MenuKind {
  if (bare(info.name).startsWith(MCP_PREFIX)) return 'mcp';
  return info.builtin ? 'builtin' : 'custom';
}

/** Terminal-only names of this session: the static list plus what the CLI reports (`init`). */
export function terminalCommands(terminalSlashCommands: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>(TERMINAL_ONLY_COMMANDS);
  for (const name of terminalSlashCommands) names.add(bare(name));
  // `/config key=value` works without the terminal UI (decided per call, see classifySlash).
  names.delete(CONFIG_COMMAND);
  return names;
}

/**
 * Entries of the slash menu: the native commands first, then the catalog (`detail.commands`,
 * ADR-108/114) – or, without a catalog, the names of `init.slashCommands`. Terminal-only commands
 * are hidden; a catalog entry with a native name merges into the native entry (its aliases stay).
 */
export function buildMenuEntries(catalog: SlashCatalog, describeNative: DescribeNative): MenuEntry[] {
  const terminal = terminalCommands(catalog.terminalSlashCommands);
  const withCatalog = catalog.commands !== null;
  const infos: readonly SlashCommandInfo[] =
    catalog.commands ??
    catalog.slashCommands.map((name) => ({
      name,
      description: '',
      argumentHint: '',
      aliases: [],
      builtin: false,
    }));
  const nativeAliases = new Map<string, string[]>();
  const result: MenuEntry[] = [];
  const seen = new Set<string>();
  const others: MenuEntry[] = [];
  for (const info of infos) {
    const name = bare(info.name);
    if (name === '' || seen.has(name) || terminal.has(name)) continue;
    seen.add(name);
    const aliases = info.aliases.map(bare).filter((alias) => alias !== '' && !terminal.has(alias));
    if ((NATIVE_COMMANDS as readonly string[]).includes(name)) {
      nativeAliases.set(name, aliases);
      continue;
    }
    others.push({
      name,
      description: info.description,
      argumentHint: info.argumentHint,
      aliases,
      kind: withCatalog ? catalogKind(info) : name.startsWith(MCP_PREFIX) ? 'mcp' : 'plain',
      native: null,
    });
  }
  for (const native of NATIVE_COMMANDS) {
    const texts = describeNative(native);
    result.push({
      name: native,
      description: texts.description,
      argumentHint: texts.argumentHint,
      aliases: nativeAliases.get(native) ?? [],
      kind: 'native',
      native,
    });
  }
  return [...result, ...others];
}

/** A query word of at least this length may match a description (shorter ones only names). */
export const DESCRIPTION_MIN_CHARS = 3;

/** Lower case without diacritics (as the fuzzy matcher compares). */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Menu entries matching `query` (V3-02): every word must match the name or an alias fuzzily, or –
 * from `DESCRIPTION_MIN_CHARS` characters on – appear in the description as one piece (no scattered
 * letters: `/vim` must not find `/clear` via "pre**v**ious … resu**m**able"). An exact name or alias
 * comes first, then entries whose words all hit names/aliases (best fuzzy score first), then those
 * found through the description; ties keep the entry order (native commands first).
 */
export function filterMenu(entries: readonly MenuEntry[], query: string): MenuEntry[] {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return [...entries];
  const exact = words.length === 1 ? bare(words[0] ?? '') : null;
  const scored: { entry: MenuEntry; rank: number; score: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const names = [entry.name, ...entry.aliases];
    const description = fold(entry.description);
    let score = 0;
    let viaDescription = false;
    for (const word of words) {
      let best: number | null = null;
      for (const name of names) {
        const value = fuzzyScore(word, name);
        if (value !== null && (best === null || value > best)) best = value;
      }
      if (best !== null) {
        score += best;
        continue;
      }
      const folded = fold(word);
      if (folded.length < DESCRIPTION_MIN_CHARS || !description.includes(folded)) return;
      viaDescription = true;
    }
    let rank = viaDescription ? 2 : 1;
    if (exact !== null && names.includes(exact)) rank = 0;
    scored.push({ entry, rank, score, index });
  });
  scored.sort((a, b) => a.rank - b.rank || b.score - a.score || a.index - b.index);
  return scored.map((item) => item.entry);
}

/**
 * The entries the slash menu shows for `query`: none when the query is exactly a terminal-only
 * command (V3-02) – the menu stays closed, Enter shows the "external console" hint instead of
 * taking another command.
 */
export function menuMatches(
  entries: readonly MenuEntry[],
  query: string,
  terminal: ReadonlySet<string>,
): MenuEntry[] {
  if (terminal.has(bare(query))) return [];
  return filterMenu(entries, query);
}

/**
 * The command word under the caret: the draft starts with `/` and the caret stands in its first
 * word (after the slash). Returns the word without the slash (may be empty), else null.
 */
export function slashQuery(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null;
  const space = text.search(/\s/);
  const end = space < 0 ? text.length : space;
  if (caret < 1 || caret > end) return null;
  return text.slice(1, end);
}

/** The draft after picking `name` in the menu: the first word replaced, the rest kept. */
export function applyMenuEntry(text: string, name: string): { text: string; caret: number } {
  const space = text.search(/\s/);
  const rest = space < 0 ? '' : text.slice(space);
  const head = `/${name}`;
  if (rest.trim() === '') return { text: `${head} `, caret: head.length + 1 };
  return { text: `${head}${rest}`, caret: head.length + 1 };
}

/** First word (the command, lower case, without slash) and the rest (trimmed) of a `/` draft. */
export function parseSlashDraft(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const word = match?.[1];
  if (word === undefined) return null;
  return { name: word.toLowerCase(), args: (match?.[2] ?? '').trim() };
}

/** What sending a `/` draft does (WP-37 §2). */
export type SlashAction =
  | { kind: 'native'; command: NativeCommand; args: string }
  | { kind: 'terminal'; name: string }
  /** Sent as a prompt (aliases of catalog commands resolved to the command name). */
  | { kind: 'pass'; text: string };

/** A native command that also sends a prompt (`/plan text`): it takes the attached images along. */
export function sendsPrompt(action: SlashAction | null): boolean {
  return action?.kind === 'native' && action.command === 'plan' && action.args !== '';
}

/** The menu entry (or native command) that `name` or one of its aliases names. */
export function resolveEntry(entries: readonly MenuEntry[], name: string): MenuEntry | null {
  const wanted = bare(name);
  return (
    entries.find((entry) => entry.name === wanted) ??
    entries.find((entry) => entry.aliases.includes(wanted)) ??
    null
  );
}

/**
 * Classifies a draft that starts with `/`: native command (also by alias), terminal-only command
 * (`config` – also by an alias like `settings` – only without `key=value`) or pass-through. Aliases
 * of catalog commands are sent as the command name. Null when the draft is no command (`/` alone).
 */
export function classifySlash(
  text: string,
  entries: readonly MenuEntry[],
  terminal: ReadonlySet<string>,
): SlashAction | null {
  const parsed = parseSlashDraft(text);
  if (parsed === null) return null;
  const { name, args } = parsed;
  if (terminal.has(name)) return { kind: 'terminal', name };
  const entry = resolveEntry(entries, name);
  const command = entry?.name ?? name;
  if (command === CONFIG_COMMAND && !KEY_VALUE.test(args)) return { kind: 'terminal', name };
  if (entry !== null && entry.native !== null) return { kind: 'native', command: entry.native, args };
  if (command !== name) {
    return { kind: 'pass', text: args === '' ? `/${command}` : `/${command} ${args}` };
  }
  return { kind: 'pass', text: text.trim() };
}
