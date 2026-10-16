# src/server/launcher – Launcher, Lockfile, Edge-Fenster, „Server beenden“ (WP-21)

Betrieb nach Plan „Server-Betrieb“, A.8, C.2, C.8, C.9 und architecture §5.1 (h)/(i), ADR-015.
Auftrag, Bedienung und Entscheidungen: `docs/wp/WP-21.md`.

- **Launcher** (eigener Prozess, läuft per tsx, nicht im Server-Bundle): ein Launcher je Home
  gleichzeitig (Named-Pipe `parallax-launch-…`, ein Doppelklick wartet, R3-04/ADR-062);
  Single-Instance über Lockfile + `GET /api/health` mit Instanz-UUID (nie per PID); läuft Parallax
  schon → Einmal-Code über `POST /api/launcher/code` (Bearer-Token, ohne Origin) und **nur ein
  weiteres Edge-Fenster** – außer der Server hat ein anderes Backend als angefordert (Health
  `backend`, Fehler `backend_mismatch`, R3-02); sonst `dist` bauen, falls fehlend/veraltet
  (Build-ID; ein Build je Checkout, Pipe `parallax-build-…`), Port prüfen, Server unsichtbar und
  detached starten, auf Lockfile (gleiche PID) + Health warten, Code holen, Edge öffnen. Exit 5
  bzw. Port belegt durch den Server dieses Homes → bis zur Bereitschaftsfrist auf ihn warten.
- **Edge-Profil** `<home>\edge`: nie angemeldet, nie synchronisiert (`--disable-sync`,
  `--disable-features=msImplicitSignin,…`, V2-01/ADR-060); ein schon angemeldetes Profil (ältere
  Version) bekommt einen Hinweis.
- **Server-Seite** (für WP-20 in `main.ts`): Lockfile schreiben/freigeben, Exit-Codes,
  Shutdown-Rahmen.
- Jeder Spawn über `lib/process.ts` (`windowsHide`, ohne Shell, nur absolute `.exe`): Server =
  `process.execPath` + absoluter Pfad zu `dist/server.js`, Edge = `findEdge` (`lib/edge.ts`).

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `main.ts` | – (Einstieg) | CLI: `parallax.cmd`/`parallax.ps1` (bzw. `pnpm start` nach Script-Änderung); Exit 0/1/2/3 |
| `args.ts` | `parseLauncherArgs`, `serverArgsFor`, `portRequested`, `LAUNCHER_USAGE` | eigene Flags (`--print-url`, `--no-build`, `--help`), Rest an `loadConfig`; an den Server explizit `--home/--port/--backend/--log-level/--validate/--toasts` (CR-11); Port-Hinweis nur bei ausdrücklichem `--port`/`PARALLAX_PORT` (V2-13) |
| `launcher.ts` | `runLauncher(options, deps)`, `createNodeLauncherDeps`, `LauncherError` (`reason`, `exitCode`), `LauncherDeps`, `LauncherOptions` (u. a. `backend`, `portExplicit`, `lockWaitMs`), `LauncherResult`, `LockAttempt`, `DEFAULT_LOCK_WAIT_MS` | Ablauf mit injizierten Abhängigkeiten, englische Meldungen; Gründe auch `backend_mismatch`, `launch_busy`, `build_busy` |
| `client.ts` | `checkHealth`, `requestLauncherCode`, `findRunningServer`, `nodeHttpJson`, `HttpJson` | HTTP auf 127.0.0.1 (`node:http`, kein Proxy, kein Keep-Alive, kein Origin) |
| `lockFile.ts` | `writeServerLock` → `ServerLockHandle` (`release()`), `readServerLock`, `serverLockPath`, `LOCK_RETRY_DELAYS_MS` | `PARALLAX_HOME/server.lock.json` atomar, `serverLockFileSchema`; Rename mit ≈ 4,6 s Retry gegen den lesenden Launcher (R2-01), Leser tolerant (`missing`/`invalid`, nie geworfen) |
| `build.ts` | `checkBuild`, `runBuild`, `BUILD_STEPS`, `readBundleBuildId`, `readWebBundleBuildId`, `resolveCheckoutBuildId`, `resolvePackageBin`, `WEB_BUILD_INFO`; Build-Lock `acquireBuildLock`, `pollLock`, `buildLockKey`, `LockAttempt`, `BUILD_LOCK_HELD_ENV`, `BUILD_LOCK_WAIT_MS`, `BUILD_LOCK_POLL_MS` | Build-ID-Vergleich `dist/server.js` ↔ `dist/web/build.json` ↔ `resolveBuildId()` (repo.config.ts; letzter Commit der Build-Eingaben, ADR-065); Build = `build:web` + `build:server` mit node; ein Build je Checkout für Launcher, E2E-Setup und `pnpm build:server`, auch auf UNC (ADR-092) |
| `serverProcess.ts` | `startServerProcess`, `probePort`, `readServerOutput`, `serverOutLogPath`, `logsDir` | detached + hidden, stdout/stderr → `logs/server.out.log` (Rotation > 1 MiB), `unref()` |
| `edgeWindow.ts` | `edgeAppArgs`, `EDGE_DISABLED_FEATURES`, `openEdgeWindow`, `locateEdge`, `edgeProfileDir`, `edgeProfileSignedIn`, `grantEdgeNotifications`, `edgePreferencesFile`, `chromiumTime`, `NotificationGrant`, `SpawnFn` | `--user-data-dir=<home>\edge --no-first-run --no-default-browser-check --disable-sync --allow-browser-signin=false --disable-features=msImplicitSignin,… --app=<url>`; vor dem Öffnen Web Notifications für den eigenen Origin im eigenen Profil erlauben (`Default\Preferences`, WP22-03, ADR-082) |
| `exitCodes.ts` | `SERVER_EXIT_CODES` | 3 = `STORE_VERSION_TOO_NEW`, 4 = Port belegt, 5 = Home belegt (`acquireHomeLock` → `busy`, R2-05) |
| `shutdown.ts` | `createServerShutdown` → `ServerShutdown` (`stop`, `stopping`, `installSignalHandlers`), `killChildProcessTrees` | Rahmen „Server beenden“: Engine-Hook → nach 5 s `taskkill /T /F` → Schritte mit Timeout → Exit (Dauer je Schritt in „shutdown: done“, WP22-05); Kinderliste dreiwertig (`unknown` → nichts beendet) |
| `launcher.ts` (Ergänzung) | `CODE_RETRY_DELAYS_MS` | Einmal-Code bei `failed` bis zu 3× mit Backoff erneut (R2-14), nie bei `token_invalid` |

Tests: Unit-Tests je Modul mit Fakes (Uhr, Spawn, HTTP, fs), `client.test.ts` gegen den echten
WP-10-Server (`startTestServer`), `launcher.integration.test.ts` mit einem Fake-Server-Skript im
Temp-Ordner (echte Prozesse, Port 0, Temp-`PARALLAX_HOME`, Edge ersetzt; auch zwei Launcher
gleichzeitig → ein Server, zwei Fenster).
