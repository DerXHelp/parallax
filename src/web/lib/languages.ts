/**
 * Languages with syntax highlighting (Shiki grammars, loaded one by one on demand –
 * `lib/highlight.ts`). This module is tiny and synchronous: the code block decides here whether
 * highlighting is worth loading at all. Unknown languages render as plain text.
 */

export const LANGUAGE_IDS = [
  'bash',
  'bat',
  'c',
  'csharp',
  'css',
  'diff',
  'docker',
  'go',
  'graphql',
  'html',
  'ini',
  'java',
  'javascript',
  'json',
  'jsonc',
  'jsx',
  'kotlin',
  'lua',
  'markdown',
  'php',
  'powershell',
  'python',
  'rust',
  'scss',
  'sql',
  'swift',
  'toml',
  'tsx',
  'typescript',
  'xml',
  'yaml',
] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];

const ALIASES: Readonly<Record<string, LanguageId>> = {
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  zsh: 'bash',
  console: 'bash',
  batch: 'bat',
  cmd: 'bat',
  h: 'c',
  // Chunk budget (500 kB): the C++ grammar alone is ~800 kB – C++ uses the C grammar; Ruby (embeds
  // C++) is not highlighted.
  cpp: 'c',
  'c++': 'c',
  cc: 'c',
  cxx: 'c',
  hpp: 'c',
  cs: 'csharp',
  'c#': 'csharp',
  patch: 'diff',
  dockerfile: 'docker',
  golang: 'go',
  gql: 'graphql',
  htm: 'html',
  conf: 'ini',
  properties: 'ini',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json5: 'jsonc',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  ps: 'powershell',
  ps1: 'powershell',
  psm1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  rs: 'rust',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  svg: 'xml',
  yml: 'yaml',
};

const IDS: ReadonlySet<string> = new Set(LANGUAGE_IDS);

function isLanguageId(value: string): value is LanguageId {
  return IDS.has(value);
}

/** Fence info string (`ts`, `TypeScript`, `js {1,3}`) → supported language or null. */
export function resolveLanguage(info: string | null | undefined): LanguageId | null {
  const name = (info ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (name === '') return null;
  if (isLanguageId(name)) return name;
  return ALIASES[name] ?? null;
}

/** Language of a file path by extension (Read/Write previews). */
export function languageForPath(path: string): LanguageId | null {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'docker';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? null : resolveLanguage(name.slice(dot + 1));
}

/** Code longer than this is shown without highlighting (render cost). */
export const HIGHLIGHT_MAX_CHARS = 20_000;
