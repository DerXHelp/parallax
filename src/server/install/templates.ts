/**
 * The stable files of an installation and the installer file of a package (WP-86, docs/wp/WP-83.md
 * §8.1/§8.3): `start.mjs` and `parallax.cmd` in the root, `install.cmd` at the package root
 * (scripts/release-pack.ts). One source each; the installer rewrites a root file only when its
 * content changed.
 *
 * `start.mjs` is plain JavaScript without imports beyond `node:` modules: it must keep working for
 * every later version (an update replaces it, but an old one may start a new version once). It
 * reads current.json, checks the Node version against the version's release.json and loads
 * `versions\<v>\dist\launcher.js` – or `dist\install.js` for `--install`, `--uninstall` and `--use`
 * – with `--install-root=<root>` in front of the arguments.
 *
 * The `.cmd` files use CRLF (cmd.exe misreads labels in LF files) and never pick up programs from
 * the current directory (`NoDefaultCurrentDirectoryInExePath`, like the checkout's parallax.cmd).
 *
 * Linux (WP-108): `parallax` in the root and `install.sh` at the package root are POSIX shell
 * scripts (LF) with the same rules – node only from absolute PATH entries; the command
 * `~/.local/bin/parallax` runs `<root>/parallax` (install/command.ts).
 */
import { PACKAGE_NODE_FLAGS } from '../launcher/release';
import { CURRENT_FILE, START_SCRIPT, VERSIONS_DIR } from './layout';

/** Arguments that start.mjs hands to the installer of the current version instead of the launcher. */
export const INSTALLER_FLAGS: readonly string[] = ['--install', '--uninstall', '--use'];

const START_SCRIPT_LINES = [
  '// Parallax start script (WP-86). Written by the installer and the same for every version: reads',
  '// current.json and runs the launcher of the current version - or its installer for --install,',
  '// --uninstall and --use. Do not edit: an update replaces this file.',
  "import { readFileSync } from 'node:fs';",
  "import path from 'node:path';",
  "import { fileURLToPath, pathToFileURL } from 'node:url';",
  '',
  'const root = path.dirname(fileURLToPath(import.meta.url));',
  'const VERSION = /^\\d+\\.\\d+\\.\\d+(?:-rc\\.\\d+)?$/;',
  `const INSTALLER_FLAGS = ${JSON.stringify(INSTALLER_FLAGS)};`,
  '',
  'function fail(message) {',
  '  process.stderr.write(`Parallax: ${message}\\n`);',
  '  process.exit(1);',
  '}',
  '',
  'function readJson(file) {',
  '  try {',
  "    return JSON.parse(readFileSync(file, 'utf8'));",
  '  } catch (error) {',
  '    return fail(`${file} could not be read (${error.message}). Install Parallax again.`);',
  '  }',
  '}',
  '',
  'function numbers(version) {',
  "  return version.split('-')[0].split('.').map(Number);",
  '}',
  '',
  'function older(actual, minimum) {',
  '  const a = numbers(actual);',
  '  const m = numbers(minimum);',
  '  for (let i = 0; i < 3; i++) {',
  '    if ((a[i] ?? 0) !== (m[i] ?? 0)) return (a[i] ?? 0) < (m[i] ?? 0);',
  '  }',
  '  return false;',
  '}',
  '',
  `const currentFile = path.join(root, ${JSON.stringify(CURRENT_FILE)});`,
  'const current = readJson(currentFile);',
  "const version = current !== null && typeof current === 'object' ? current.version : undefined;",
  "if (typeof version !== 'string' || !VERSION.test(version)) {",
  '  fail(`${currentFile} names no valid version. Install Parallax again.`);',
  '}',
  `const versionDir = path.join(root, ${JSON.stringify(VERSIONS_DIR)}, version);`,
  "const release = readJson(path.join(versionDir, 'release.json'));",
  "const minNode = release !== null && typeof release.minNode === 'string' ? release.minNode : '0.0.0';",
  'if (older(process.versions.node, minNode)) {',
  '  fail(`Parallax ${version} needs Node.js ${minNode} or newer, this is ${process.versions.node}.`);',
  '}',
  'const args = process.argv.slice(2);',
  'const installer = args.some((arg) =>',
  '  INSTALLER_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),',
  ');',
  "const entry = path.join(versionDir, 'dist', installer ? 'install.js' : 'launcher.js');",
  'process.argv.splice(2, 0, `--install-root=${root}`);',
  'await import(pathToFileURL(entry).href);',
  '',
];

/** Content of `<root>\start.mjs`. */
export function startScript(): string {
  return START_SCRIPT_LINES.join('\n');
}

const cmd = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;
const NODE_FLAGS = PACKAGE_NODE_FLAGS.join(' ');

/** Content of `<root>\parallax.cmd` (`minNode`: the hint without Node). */
export function startCmd(minNode: string): string {
  return cmd([
    '@echo off',
    'rem Parallax (WP-86): starts the installed version. Written by the installer, replaced by updates.',
    'rem Options: parallax.cmd --help. Uninstall: parallax.cmd --uninstall (the data stay).',
    'setlocal',
    'rem Never pick up programs from the current directory (cmd searches it before the PATH).',
    'set "NoDefaultCurrentDirectoryInExePath=1"',
    '"%SystemRoot%\\System32\\where.exe" node >nul 2>nul',
    'if errorlevel 1 goto nonode',
    `node ${NODE_FLAGS} "%~dp0${START_SCRIPT}" %*`,
    'if errorlevel 1 goto failed',
    'exit /b 0',
    '',
    ':nonode',
    `echo Parallax: Node.js was not found on the PATH - install Node.js ${minNode} or newer.`,
    '',
    ':failed',
    'set "PARALLAX_EXIT=%errorlevel%"',
    'if "%PARALLAX_EXIT%"=="0" set "PARALLAX_EXIT=1"',
    'rem Keep a double-clicked window open so the message can be read (PARALLAX_NO_PAUSE=1 skips it).',
    'if not defined PARALLAX_NO_PAUSE pause',
    'exit /b %PARALLAX_EXIT%',
  ]);
}

/**
 * Content of `install.cmd` at the package root. No Node flags here: an older Node would reject
 * them before install.js can say which version it needs – install.js adds them itself.
 */
export function installCmd(minNode: string): string {
  return cmd([
    '@echo off',
    'rem Installs or updates Parallax from this unpacked folder (WP-86, README "Installieren").',
    'rem Options: install.cmd --help. The same without this file: node dist\\install.js',
    'setlocal',
    'rem Never pick up programs from the current directory (cmd searches it before the PATH).',
    'set "NoDefaultCurrentDirectoryInExePath=1"',
    '"%SystemRoot%\\System32\\where.exe" node >nul 2>nul',
    'if errorlevel 1 goto nonode',
    'node "%~dp0dist\\install.js" %*',
    'set "PARALLAX_EXIT=%errorlevel%"',
    'goto done',
    '',
    ':nonode',
    `echo Parallax needs Node.js ${minNode} or newer: https://nodejs.org/`,
    'set "PARALLAX_EXIT=1"',
    '',
    ':done',
    'rem Keep a double-clicked window open so the result can be read (PARALLAX_NO_PAUSE=1 skips it).',
    'if not defined PARALLAX_NO_PAUSE pause',
    'exit /b %PARALLAX_EXIT%',
  ]);
}

// ---- Linux (WP-108): POSIX shell scripts (LF, `#!/bin/sh`, no bashisms) ----

const sh = (lines: readonly string[]): string => `${lines.join('\n')}\n`;

/**
 * Sets `node` to the first executable `node` of the ABSOLUTE `PATH` entries – an empty or relative
 * entry would search the current folder (the POSIX counterpart of NoDefaultCurrentDirectoryInExePath,
 * like lib/executables.ts `searchPosixPath`). No globbing while splitting.
 */
const FIND_NODE: readonly string[] = [
  '# node from the absolute PATH entries only: an empty or relative entry would search the current folder.',
  'node=',
  'set -f',
  'IFS=:',
  'for dir in ${PATH:-}; do',
  '  case $dir in',
  '    /*) if [ -f "$dir/node" ] && [ -x "$dir/node" ]; then node=$dir/node; break; fi ;;',
  '  esac',
  'done',
  'unset IFS',
  'set +f',
];

/** `X.Y.Z` → its three numbers (a malformed `minNode` never reaches a template: release.json checks it). */
function versionParts(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

/**
 * Content of `<root>/parallax` (Linux): the POSIX counterpart of parallax.cmd – finds node on the
 * PATH and runs `start.mjs` next to it (also when started through a symbolic link) with the network
 * flags. `~/.local/bin/parallax` (install/command.ts) only runs this file, so an update brings its
 * own start script (`root/parallax` of the package).
 */
export function startShell(minNode: string): string {
  return sh([
    '#!/bin/sh',
    '# Parallax (WP-108): starts the installed version. Written by the installer, replaced by updates.',
    '# Options: parallax --help. Uninstall: parallax --uninstall (the data stay).',
    'set -u',
    '# The folder of this script, also when it was started through a symbolic link.',
    'self=$(readlink -f -- "$0" 2>/dev/null) || self=$0',
    'root=$(dirname -- "$self")',
    ...FIND_NODE,
    'if [ -z "$node" ]; then',
    `  echo "Parallax: Node.js was not found on the PATH - install Node.js ${minNode} or newer." >&2`,
    '  exit 1',
    'fi',
    `exec "$node" ${NODE_FLAGS} "$root/${START_SCRIPT}" "$@"`,
  ]);
}

/**
 * Content of `install.sh` at the package root (Linux, `sh install.sh`): finds node, checks that it
 * starts (the official build needs libatomic1) and is at least `minNode`, then runs
 * `dist/install.js` – no Node flags, like install.cmd (install.js adds them itself and checks the
 * rest, OpenSSL included).
 */
export function installSh(minNode: string): string {
  const [major, minor, patch] = versionParts(minNode);
  return sh([
    '#!/bin/sh',
    '# Installs or updates Parallax from this unpacked folder (WP-108, README "Ubuntu").',
    '# Options: sh install.sh --help. The same without this file: node dist/install.js',
    'set -u',
    'here=$(cd -- "$(dirname -- "$0")" && pwd -P) || exit 1',
    ...FIND_NODE,
    'if [ -z "$node" ]; then',
    `  echo "Parallax needs Node.js ${minNode} or newer (the official build from https://nodejs.org/) - node was not found on the PATH." >&2`,
    '  exit 1',
    'fi',
    'version=$("$node" -p process.versions.node 2>/dev/null) || version=',
    'case $version in',
    '  [0-9]*.[0-9]*.[0-9]*) ;;',
    '  *)',
    '    echo "Parallax: $node does not start - a minimal Ubuntu needs libatomic1 (sudo apt install libatomic1)." >&2',
    '    exit 1',
    '    ;;',
    'esac',
    'major=${version%%.*}',
    'rest=${version#*.}',
    'minor=${rest%%.*}',
    'patch=${rest#*.}',
    'patch=${patch%%[!0-9]*}',
    `if [ "$major" -lt ${String(major)} ] ||`,
    `  { [ "$major" -eq ${String(major)} ] && [ "$minor" -lt ${String(minor)} ]; } ||`,
    `  { [ "$major" -eq ${String(major)} ] && [ "$minor" -eq ${String(minor)} ] && [ "\${patch:-0}" -lt ${String(patch)} ]; }; then`,
    `  echo "Parallax needs Node.js ${minNode} or newer, this is $version: https://nodejs.org/" >&2`,
    '  exit 1',
    'fi',
    'exec "$node" "$here/dist/install.js" "$@"',
  ]);
}

/** The marker line of the `parallax` command: which installation root it belongs to. */
export const COMMAND_ROOT_MARKER = '# parallax-install-root: ';

/** `text` as one single-quoted shell word (`'` → `'\''`). */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Content of `~/.local/bin/parallax` (Linux, install/command.ts): runs `<root>/parallax`. Written by
 * the installer for exactly this root (the marker line names it) and stable across updates – the
 * version-specific part is `<root>/parallax`. `root` passed the POSIX path rules (no control
 * character, so no line break).
 */
export function commandScript(root: string, startFile: string): string {
  return sh([
    '#!/bin/sh',
    '# Parallax (WP-108): the command of the installation below, written by its installer and removed by',
    '# "parallax --uninstall". Do not edit.',
    `${COMMAND_ROOT_MARKER}${root}`,
    `exec ${shellQuote(startFile)} "$@"`,
  ]);
}

/** The root a `parallax` command names in its marker line, or null (not a command of an installer). */
export function commandScriptRoot(text: string): string | null {
  if (!text.startsWith('#!/bin/sh\n')) return null;
  for (const line of text.split('\n')) {
    if (line.startsWith(COMMAND_ROOT_MARKER)) return line.slice(COMMAND_ROOT_MARKER.length);
  }
  return null;
}
