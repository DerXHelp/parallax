# src/server/launcher – Launcher, Lockfile, Edge-Fenster, „Server beenden“ (WP-21)

Betrieb nach Plan „Server-Betrieb“, A.8, C.2, C.8, C.9 und architecture §5.1 (h)/(i), ADR-015.
Auftrag, Bedienung und Entscheidungen: `docs/wp/WP-21.md`.

- **Launcher** (eigener Prozess, läuft per tsx, nicht im Server-Bundle): Single-Instance über
  Lockfile + `GET /api/health` mit Instanz-UUID (nie per PID); läuft Parallax schon → Einmal-Code
  über `POST /api/launcher/code` (Bearer-Token, ohne Origin) und **nur ein weiteres Edge-Fenster**;
  sonst `dist` bauen, falls fehlend/veraltet (Build-ID), Port prüfen, Server unsichtbar und
  detached starten, auf Lockfile (gleiche PID) + Health warten, Code holen, Edge öffnen.
- **Server-Seite** (für WP-20 in `main.ts`): Lockfile schreiben/freigeben, Exit-Codes,
  Shutdown-Rahmen.
- Jeder Spawn über `lib/process.ts` (`windowsHide`, ohne Shell, nur absolute `.exe`): Server =
  `process.execPath` + absoluter Pfad zu `dist/server.js`, Edge = `findEdge` (`lib/edge.ts`).

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `main.ts` | – (Einstieg) | CLI: `parallax.cmd`/`parallax.ps1` (bzw. `pnpm start` nach Script-Änderung); Exit 0/1/2/3 |
| `args.ts` | `parseLauncherArgs`, `serverArgsFor`, `LAUNCHER_USAGE` | eigene Flags (`--print-url`, `--no-build`, `--help`), Rest an `loadConfig` |
| `launcher.ts` | `runLauncher(options, deps)`, `createNodeLauncherDeps`, `LauncherError` (`reason`, `exitCode`), `LauncherDeps`, `LauncherOptions`, `LauncherResult` | Ablauf mit injizierten Abhängigkeiten, englische Meldungen |
| `client.ts` | `checkHealth`, `requestLauncherCode`, `findRunningServer`, `nodeHttpJson`, `HttpJson` | HTTP auf 127.0.0.1 (`node:http`, kein Proxy, kein Keep-Alive, kein Origin) |
| `lockFile.ts` | `writeServerLock` → `ServerLockHandle` (`release()`), `readServerLock`, `serverLockPath` | `PARALLAX_HOME/server.lock.json` atomar, `serverLockFileSchema` |
| `build.ts` | `checkBuild`, `runBuild`, `BUILD_STEPS`, `readBundleBuildId`, `resolveCheckoutBuildId`, `resolvePackageBin` | Build-ID-Vergleich `dist/server.js` ↔ `resolveBuildId()` (repo.config.ts); Build = `build:web` + `build:server` mit node |
| `serverProcess.ts` | `startServerProcess`, `probePort`, `readServerOutput`, `serverOutLogPath`, `logsDir` | detached + hidden, stdout/stderr → `logs/server.out.log` (Rotation > 1 MiB), `unref()` |
| `edgeWindow.ts` | `edgeAppArgs`, `openEdgeWindow`, `locateEdge`, `edgeProfileDir`, `SpawnFn` | `--user-data-dir=<home>\edge --no-first-run --no-default-browser-check --app=<url>` |
| `exitCodes.ts` | `SERVER_EXIT_CODES` | 3 = `STORE_VERSION_TOO_NEW`, 4 = Port belegt, 5 = läuft schon (optional) |
| `shutdown.ts` | `createServerShutdown` → `ServerShutdown` (`stop`, `stopping`, `installSignalHandlers`), `killChildProcessTrees` | Rahmen „Server beenden“: Engine-Hook → nach 5 s `taskkill /T /F` → Schritte mit Timeout → Exit |

Tests: Unit-Tests je Modul mit Fakes (Uhr, Spawn, HTTP, fs), `client.test.ts` gegen den echten
WP-10-Server (`startTestServer`), `launcher.integration.test.ts` mit einem Fake-Server-Skript im
Temp-Ordner (echte Prozesse, Port 0, Temp-`PARALLAX_HOME`, Edge ersetzt).
