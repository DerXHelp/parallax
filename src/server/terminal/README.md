# src/server/terminal – Shell im Projektordner (WP-97), ConPTY-Spike (WP-98), eingebettetes Terminal (WP-99), Linux (WP-105)

Owner: **Koordinator** (WP-97…99, `feature/konsole`); Linux-Welle L2: **WP-105** (ohne `ports.ts`). Auftrag und
Ergebnis: `docs/wp/WP-97.md` (Fenster), `docs/wp/WP-98.md` (Spike), `docs/wp/WP-99.md` (Terminal, Teilberichte
WP-99a/99b), `docs/wp/WP-105.md` (Linux); Entscheidungen ADR-238, ADR-239.

Fenster nur auf diesem Rechner: `session.openShell` steht in `REMOTE_DENIED_COMMANDS` (`@shared/protocol`), ein Fenster
eines anderen Rechners öffnet hier nie ein Shell-Fenster. `shell.detect` und das eingebettete Terminal gehen seit
WP-102 (E3, ADR-244) auch über den Vermittler (`HOST_API_PATHS.terminalWs` → `REMOTE_PATHS.terminalWs`, WP-107).

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `shells.ts` | `shellEnvironment(base?, platform?)`, `isGitDir`, `findGitDir`, `createGitFinder({ttlMs?, now?})` → `GitFinder`, `resolveShellLaunch(kind, cwd, settings, mode, deps)` → `ShellLaunch`, `gitBashCdArgument`, `GIT_BASH_EXE`, `GIT_BASH_CONSOLE`, `GIT_CACHE_MS`; WP-105: `findLoginShell(env, fs, passwdShell?)`, `userPasswdShell()`, `posixLoginArgs(program)`, `availablePosixShells(env, fs?)`, `POSIX_FALLBACK_SHELLS` | Was für `cmd`, `powershell` und `gitbash` (Windows) bzw. `login`, `bash`, `zsh`, `fish`, `pwsh` (Linux) startet, mit welchen Argumenten und welcher Umgebung (Modus `window` für WP-97, `embedded` für WP-99). Die Kinds der anderen Plattform → `SHELL_NOT_FOUND` |
| `shellCommands.ts` | `createShellCommands(deps)` → `HostCommandHandler` (`names: ['session.openShell', 'shell.detect']`), `createRecordingShellLauncher({logger?})` | Host-Befehle; das Fenster öffnet der `ConsoleLauncher` der externen Konsole (`system/console.ts`, ADR-104; unter Linux die Variante von WP-106). `shell.detect`: Windows `gitDir` + die drei Shells, Linux `gitDir: null` + `login` und die installierten (ohne Git-Suche, ohne `reg.exe`) |
| `unixPty.ts` | `createUnixPtyFactory(deps?)` → `PtyFactory \| null`, `unixPtyUnavailableReason()` → `'platform' \| 'ffi'`, `loadUnixPty(deps?)` → `UnixPtyApi`, `UnixPtyError {step, code}`, `unixPtyEnvironment`, `winsize`, `childExitCode`, `UNIX_PTY_*`, `resetUnixPtyForTests` | WP-105 (Spike WP-101): Linux-Pseudoterminal über `node:ffi` (libc). `/dev/ptmx` nicht blockierend, `unlockpt`, `ptsname_r`, `ioctl(TIOCSWINSZ)`; Start `setsid -c <programm> …` ohne `detached` (setsid forkt nicht, die PID ist das Programm, Leiter einer neuen Sitzung mit dem Slave als Terminal). `read`: `EAGAIN` → null, `EIO`/EOF → Ende. `write`: Warteschlange bis 1 MiB, Stücke zu 4 KiB, Rest per Timer (`EAGAIN` ab ~18 KiB). `close`: Master schließen (SIGHUP), dann die ganze Sitzung über `killProcessTree` (auch `nohup`-Jobs) – sofort, solange das Programm nicht eingesammelt ist, danach nur, solange ein Prozess mit `sid = pid` lebt. Echte Tests mit `runIf(linux)` in `unixPty.test.ts` |
| `platformPty.ts` | `createPlatformPty(platform?, {unix?})` → `{pty}` \| `{pty: null, unavailableReason}` | WP-105: die Pty der Plattform für die Komposition (ConPTY unter Windows, `unixPty` unter Linux, sonst `platform`) |
| `conpty.ts` | `createConPtyFactory()` → `PtyFactory \| null`, `conPtyUnavailableReason()` → `'platform' \| 'ffi'`, `loadConPty()` → `ConPtyApi {spawn(options)}` → `ConPty` (ein `PtyProcess` mit Zahl als `pid`), `ConPtyError {step, code}`, `conPtyCommandLine`, `CONPTY_READ_MAX` | WP-98 (Spike), seit WP-99 Produktion: Pseudokonsole über `node:ffi` (kernel32). `read` blockiert nie (`PeekNamedPipe`), `write` auch nicht: Eingabe-Pipe `PIPE_NOWAIT`, Warteschlange bis 1 MiB, Stücke zu 1 KiB, Rest per Timer (sonst hängt der ganze Server, sobald conhost bei voller Ausgabe-Pipe keine Eingabe mehr nimmt). `close` schließt zuerst die Ausgabe-Pipe, dann die Konsole, die angehängte Prozesse beendet; das Prozess-Handle bleibt, bis `exitCode()` das Ende sieht (PID bleibt reserviert). Vor dem ersten Start `SetConsoleCtrlHandler(NULL, FALSE)`, sonst erbt die Shell „Ctrl+C ignorieren“ (`docs/wp/WP-98.md`). Echte Prüfung nur per Opt-in: `conpty.live.test.ts` mit `PARALLAX_CONPTY_TEST=1` |
| `envBlock.ts` | `environmentBlock(env)` | Umgebungsblock für `CreateProcessW` (UTF-16, ohne Groß-/Kleinschreibung sortiert, Doppelte und Ungültiges entfernt) |
| `service.ts` | `createTerminalService(options: TerminalServiceOptions)` → `TerminalService`, `TerminalLaunch`, `startFailureReason`, `TERMINAL_BACKPRESSURE`, `TERMINAL_FRAME_BYTES`, `EXIT_GRACE_MS`, `EXIT_DRAIN_MAX_MS`, `KILL_FALLBACK_MS` | WP-99: Shells, Scrollback und Sockets. `open` prüft verfügbar → Eintrag → nicht archiviert → Grenzen (4 je Eintrag inkl. beendeter und laufender Öffnungen, 16 gesamt) → `checkCwd` → Start (`resolveShellLaunch(…, 'embedded')`) → `pty.spawn`. `attach`: kleinster freier Kanal, Replay des Rings, Resize und Schubs. Exit: Rest lesen (50 ms bis 1 s), `close`, Zustand `exited`, Ring bleibt. Gegendruck je Socket: über 1 MiB nicht mehr lesen, unter 256 KiB weiter, über 8 MiB oder 30 s pausiert → 1013. `closeEntry`/`closeAll` mit `exit {reason}`; läuft eine Shell 2 s nach `close` noch (laut `exitCode()` der Pty, nie per nackter PID), bekommt `killTree` die PID. Eingaben werden nie geloggt |
| `poller.ts` | `createPoller(hooks, {timers?, now?, onError?})` → `Poller {wake, tick, stop, running}`, `POLL_ACTIVE_MS`, `POLL_IDLE_MS`, `POLL_TERMINAL_BYTES`, `POLL_TICK_BYTES` | Ein gemeinsamer Timer (unref): 16 ms nach Daten, sonst 100 ms, `wake` (Eingabe) holt den Tick vor. Höchstens 64 KiB je Terminal und 256 KiB je Tick, Start reihum. Alle Reads eines Terminals im Tick werden zu einem Frame. Exit-Prüfung in jedem Tick |
| `ring.ts` | `createByteRing(capacity?)` → `ByteRing {size, capacity, push, snapshot, clear}`, `RING_LINE_SEARCH_BYTES` | Scrollback je Terminal (`TERMINAL_LIMITS.scrollbackBytes`), kopiert in eigene Blöcke zu 16 KiB (kleine `Buffer` aus dem Pool würden sonst ganze Slabs festhalten). Beim Kürzen wird am ersten `\n` hinter dem Schnittpunkt geschnitten, wenn es innerhalb von 4 KiB liegt, sonst hart (nie mitten in einem UTF-8-Zeichen) |
| `socket.ts` | `registerTerminalRoute(app, options: TerminalRouteOptions)` → `TerminalRoute {handleSocket, closeAll, connections}`, `TerminalSocket`, `DEFAULT_TERMINAL_SOCKET_TIMING`, `TERMINAL_SOCKET_LIMITS` | Route `API_PATHS.terminalWs`, registriert wie die des Hubs (`authorize` in `preValidation` und im WS-Handler). `hello` zuerst und binnen 10 s (sonst 4400), anderes Protokoll 4426, unbekannter Eintrag 4404. Danach nur JSON-Text bis 385 KiB (`6 × inputMaxChars + 1024` Bytes); Ungültiges → `error` `INVALID_MESSAGE`, mehr als 10 in 10 s → 4400. Ping alle 30 s, `onRevoked` → 4401 |
| `fakePty.ts` | `createFakePtyFactory()` → `FakePtyFactory {spawn, spawned}`, `fakePrompt`, `FAKE_FLOOD_MAX_LINES` | Fake-Shell für Tests, Dev und E2E mit dem FakeBackend: startet nichts. Prompt nach Programmname (WP-105: `bash`, `sh`, `zsh` → `$ `), Echo, `echo X`, `exit [n]`, `flood N`, `cls`, sonst „not recognized“; `\x03` → `^C` und Prompt; `pid` null |

**Verdrahtung (Koordinator, WP-99):**
1. `http/origin.ts`: `API_PATHS.terminalWs` als Routenklasse `ws` (wie `API_PATHS.ws`), sonst lehnt der Wächter das
   Upgrade ab.
2. `http/app.ts`: neue Option (z. B. `terminal?: TerminalService`); nach dem Hub
   `registerTerminalRoute(app, { service, authorize: (request) => authorize(request, API_PATHS.terminalWs, true),
   onRevoked: (listener) => auth.onRevoked(listener), logger: log })`. Die Route meldet `onRevoked` beim Schließen der
   App selbst ab; beim Server-Ende schließt das `preClose` des WebSocket-Plugins auch diese Sockets.
3. `app/compose.ts`: SdkBackend `pty = createConPtyFactory()` (bei null `unavailableReason: conPtyUnavailableReason()`;
   seit WP-105 stattdessen `...createPlatformPty()`), FakeBackend `createFakePtyFactory()`. `createTerminalService({ pty, unavailableReason, entry: (id) => ({ cwd,
   archived }) | null, settings: () => settings.console, killTree: killProcessTree, gitFinder })`; den `GitFinder`
   mit `createShellCommands` teilen. `host.terminalAvailable = service.available`. Archivieren →
   `closeEntry(id, 'archived')`, Entfernen → `closeEntry(id, 'removed')`, Server-Ende → `await closeAll()` vor
   `app.close()`.

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

**Start unter Linux (WP-105):**
- `login`: `$SHELL`, sonst die Shell des passwd-Eintrags (`os.userInfo().shell`, auch NSS), sonst `/bin/bash`, sonst
  `/bin/sh`. Jeder Kandidat muss nach den POSIX-Regeln sicher und absolut sein (auch sein `realpath`), ausführbar und
  weder `nologin` noch `false`/`true`.
- `bash`, `zsh`, `fish`, `pwsh`: `resolveExecutable(kind, env, fs, 'linux')` auf dem PATH der Shell-Umgebung (ohne
  `node_modules/.bin`), sonst `SHELL_NOT_FOUND {shell}`.
- Argumente eingebettet und im Fenster gleich: Login-Shell `-l`, fish `--login`, pwsh `-Login -NoLogo`.
- Eingebettet setzt `unixPty` `TERM=xterm-256color` und `COLORTERM=truecolor` und entfernt die Variablen des äußeren
  Terminals (`TERM_PROGRAM`, `TMUX`, `KITTY_*` …); `LANG=C.UTF-8` nur ohne jede Locale.

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
- `SHELL_NOT_FOUND {shell}`, wenn Git for Windows fehlt, die Linux-Shell nicht installiert ist oder der Kind zur
  anderen Plattform gehört
- `SHELL_OPEN_FAILED {reason}`, wenn der Launcher scheitert. Der Grund wird bereinigt wie bei der externen
  Konsole (`scrubConsoleReason`).

Es gibt kein Lebenszyklus-Gate (auch ruhende, archivierte und externe Einträge haben einen Ordner), und nichts wird
danach verfolgt.

**FakeBackend** (Dev, E2E): `createRecordingShellLauncher` öffnet nichts und loggt
`session.openShell (fake): <exe> <args>`.
