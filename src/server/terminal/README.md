# src/server/terminal – Shell im Projektordner (WP-97), ConPTY-Spike (WP-98) und eingebettetes Terminal (WP-99)

Owner: **Koordinator** (WP-97…99, `feature/konsole`). Auftrag und Ergebnis: `docs/wp/WP-97.md`; Entscheidung ADR-238.

Nur auf diesem Rechner: Beide Befehle stehen in `REMOTE_DENIED_COMMANDS` (`@shared/protocol`). Ein Fenster eines
anderen Rechners öffnet hier nie eine Shell.

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `shells.ts` | `shellEnvironment(base?)`, `isGitDir`, `findGitDir`, `createGitFinder({ttlMs?, now?})` → `GitFinder`, `resolveShellLaunch(kind, cwd, settings, mode, deps)` → `ShellLaunch`, `gitBashCdArgument`, `GIT_BASH_EXE`, `GIT_BASH_CONSOLE`, `GIT_CACHE_MS` | Was für `cmd`, `powershell` und `gitbash` startet, mit welchen Argumenten und welcher Umgebung (Modus `window` für WP-97, `embedded` für WP-99) |
| `shellCommands.ts` | `createShellCommands(deps)` → `HostCommandHandler` (`names: ['session.openShell', 'shell.detect']`), `createRecordingShellLauncher({logger?})` | Host-Befehle; das Fenster öffnet der `ConsoleLauncher` der externen Konsole (`system/console.ts`, ADR-104) |
| `conpty.ts` | `loadConPty()` → `ConPtyApi {spawn(options)}` → `ConPty {pid, read(max), write, resize, exitCode(), close()}`, `ConPtyError {step, code}`, `conPtyCommandLine`, `CONPTY_READ_MAX` | WP-98 (Spike), wird in WP-99 Produktion: Pseudokonsole über `node:ffi` (kernel32). `read` blockiert nie (`PeekNamedPipe`). `close` schließt zuerst die Ausgabe-Pipe, dann die Konsole, die angehängte Prozesse beendet. Vor dem ersten Start `SetConsoleCtrlHandler(NULL, FALSE)`, sonst erbt die Shell „Ctrl+C ignorieren“ (`docs/wp/WP-98.md`) |
| `envBlock.ts` | `environmentBlock(env)` | Umgebungsblock für `CreateProcessW` (UTF-16, ohne Groß-/Kleinschreibung sortiert, Doppelte und Ungültiges entfernt) |

**Start:**
- `cmd`: `%SystemRoot%\System32\cmd.exe`.
- `powershell`: Windows PowerShell 5.1 (`powerShellPath`) mit `-NoLogo`. Das Benutzerprofil lädt wie in jedem
  neuen Fenster.
- `gitbash`, Fenster `mintty`: `<Git>\git-bash.exe "--cd=<cwd>"`, wie der Explorer-Eintrag „Open Git Bash here“.
  Eine Laufwerkswurzel `D:\` bekommt einen `.`, damit das Argument nicht auf `\` endet.
- `gitbash`, Fenster `terminal` und eingebettet: `<Git>\bin\bash.exe --login -i` mit `CHERE_INVOKING=1`. Git for Windows
  bleibt auch ohne die Variable im `cwd` (geprüft am 20.11.2026, auch mit Leerzeichen und Umlauten). Sie sichert
  Profile nach MSYS2-Art ab, die sonst nach `$HOME` wechseln.
- Das Fenster öffnet immer über `ConsoleLauncher.open`: versteckte PowerShell, konstantes Skript,
  `Start-Process -WorkingDirectory <cwd>`, Daten nur in Umgebungsvariablen. `spawnGui` startet nur
  GUI-Programme und blockt Shells. Ein von Node direkt gestartetes Konsolenprogramm bekäme keine Konsole
  (libuv-Std-Handles, `DETACHED_PROCESS`).

**Umgebung (Entscheidung des Nutzers, 20.11.2026): neutral.**
- `guiEnvironment` (`lib/process.ts`) ohne die Variablen einer aufrufenden Claude-Session, ohne jedes `PARALLAX*`
  und ohne den `pnpm run`-Zustand.
- PATH ohne `node_modules\.bin` (`stripNodeModulesBin`).
- Keine Profil-Env und kein `CLAUDE_CONFIG_DIR`: Ein dort getipptes `claude` nutzt das Standardkonto des Nutzers.

**Git-Suche:** Ruhige Quellen kommen zuerst, damit der Normalfall kein `reg.exe` startet.
1. Ordner aus den Einstellungen (`settings.console.gitDir`)
2. `%ProgramFiles%\Git`
3. `%LOCALAPPDATA%\Programs\Git`
4. Ordner von `git.exe` auf PATH, eine oder zwei Ebenen höher
5. Uninstall-Key `Git_is1` → `InstallLocation` (HKCU, HKLM 64/32 Bit)

Jeder Kandidat braucht einen sicheren absoluten Pfad mit `git-bash.exe` und `bin\bash.exe`. Ein Treffer gilt eine
Minute (`createGitFinder`). `shell.detect` sucht immer neu.

**Fehler:**
- `ENTRY_NOT_FOUND`
- `PATH_REJECTED`, `CWD_NOT_FOUND`, `CWD_NOT_DIRECTORY` (`checkCwd`)
- `SHELL_NOT_FOUND {shell}`, wenn Git for Windows fehlt
- `SHELL_OPEN_FAILED {reason}`, wenn der Launcher scheitert. Der Grund wird bereinigt wie bei der externen
  Konsole (`scrubConsoleReason`).

Es gibt kein Lebenszyklus-Gate (auch ruhende, archivierte und externe Einträge haben einen Ordner), und nichts wird
danach verfolgt.

**FakeBackend** (Dev, E2E): `createRecordingShellLauncher` öffnet nichts und loggt
`session.openShell (fake): <exe> <args>`.
