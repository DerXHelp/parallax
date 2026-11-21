/**
 * Terminal emulators on a Linux desktop (WP-106, WP-100 §5.4/§5.5): the window of "Open shell in
 * folder" (WP-97) and of the external console (ADR-104) opens a terminal emulator that runs one
 * program. Lookup order: the setting `console.terminalEmulator` (an absolute program) →
 * `xdg-terminal-exec` (the XDG proposal, the desktop's choice) → `x-terminal-emulator` (Debian's
 * alternative) → the known ones on `PATH` (Ptyxis, GNOME Terminal, Konsole, Xfce Terminal, kitty,
 * Alacritty, WezTerm, foot, xterm). Only absolute programs from `PATH` entries that pass the POSIX
 * rules (lib/executables.ts), never a bare name.
 *
 * Every emulator has its own syntax for the working folder and the command (`terminalCommandArgs`);
 * the working folder is also the cwd of the started emulator (the dispatchers and xterm have no
 * option for it). The command is passed as separate arguments after the emulator's "execute the
 * rest" option – no shell, no command line to quote. An unknown program from the setting gets the
 * Debian convention `-e <command…>`.
 */
import path from 'node:path';
import { POSIX_PATHS } from '@shared/paths';
import { searchPosixPath } from '../lib/executables';
import type { FsProbe } from '../lib/windows';

export const TERMINAL_EMULATOR_KINDS = [
  'xdg-terminal-exec',
  'x-terminal-emulator',
  'ptyxis',
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'kitty',
  'alacritty',
  'wezterm',
  'foot',
  'xterm',
  'generic',
] as const;
export type TerminalEmulatorKind = (typeof TERMINAL_EMULATOR_KINDS)[number];

/** Program names searched on `PATH`, in lookup order, and the syntax each one gets. */
export const TERMINAL_EMULATOR_NAMES: readonly (readonly [string, TerminalEmulatorKind])[] = [
  ['xdg-terminal-exec', 'xdg-terminal-exec'],
  ['x-terminal-emulator', 'x-terminal-emulator'],
  ['ptyxis', 'ptyxis'],
  ['gnome-terminal', 'gnome-terminal'],
  ['konsole', 'konsole'],
  ['xfce4-terminal', 'xfce4-terminal'],
  ['kitty', 'kitty'],
  ['alacritty', 'alacritty'],
  ['wezterm', 'wezterm'],
  ['foot', 'foot'],
  ['xterm', 'xterm'],
];

export interface TerminalEmulator {
  /** Absolute program. */
  file: string;
  kind: TerminalEmulatorKind;
}

/** The syntax of a program by its base name (`/usr/bin/kitty` → `kitty`); unknown → `generic`. */
export function terminalKindOf(file: string): TerminalEmulatorKind {
  const base = path.posix.basename(file);
  for (const [name, kind] of TERMINAL_EMULATOR_NAMES) if (base === name) return kind;
  return 'generic';
}

export interface TerminalLookupDeps {
  /** `console.terminalEmulator` of the settings (null = detect). */
  configured: string | null;
  /** `PATH` of the lookup. */
  env: Readonly<Record<string, string | undefined>>;
  fs: FsProbe;
}

/**
 * The terminal emulator to use, or null (see the file comment). A configured program must be an
 * absolute, safe, executable file – a missing one is no reason to start another emulator silently
 * (the user chose it): null.
 */
export async function resolveTerminalEmulator(deps: TerminalLookupDeps): Promise<TerminalEmulator | null> {
  const executable = (file: string): Promise<boolean> =>
    deps.fs.isExecutable === undefined ? deps.fs.isFile(file) : deps.fs.isExecutable(file);
  if (deps.configured !== null) {
    if (POSIX_PATHS.issue(deps.configured) !== null) return null;
    return (await executable(deps.configured))
      ? { file: deps.configured, kind: terminalKindOf(deps.configured) }
      : null;
  }
  for (const [name, kind] of TERMINAL_EMULATOR_NAMES) {
    const [hit] = await searchPosixPath(name, deps.env, deps.fs);
    if (hit !== undefined) return { file: hit, kind };
  }
  return null;
}

/**
 * The emulator's arguments that open ONE new window in `cwd` running `command` (program + its
 * arguments, `command[0]` absolute). The emulator is started with `cwd` as its working folder too.
 */
export function terminalCommandArgs(
  kind: TerminalEmulatorKind,
  cwd: string,
  command: readonly string[],
): string[] {
  switch (kind) {
    case 'xdg-terminal-exec':
      return [...command];
    case 'ptyxis':
      return ['--new-window', `--working-directory=${cwd}`, '--', ...command];
    case 'gnome-terminal':
      return ['--window', `--working-directory=${cwd}`, '--', ...command];
    case 'konsole':
      return ['--workdir', cwd, '-e', ...command];
    case 'xfce4-terminal':
      return ['--window', `--working-directory=${cwd}`, '-x', ...command];
    case 'kitty':
      return ['--directory', cwd, ...command];
    case 'alacritty':
      return ['--working-directory', cwd, '-e', ...command];
    case 'wezterm':
      return ['start', '--always-new-process', '--cwd', cwd, '--', ...command];
    case 'foot':
      return [`--working-directory=${cwd}`, ...command];
    case 'x-terminal-emulator':
    case 'xterm':
    case 'generic':
      return ['-e', ...command];
  }
}
