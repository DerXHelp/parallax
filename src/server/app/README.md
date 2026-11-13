# src/server/app – Komposition (WP-20a, WP-20c, WP-40, WP-60)

Kompositionswurzel des Servers: der einzige Ort, der alle Server-Module zusammensetzt. `main.ts`
lädt Config, nimmt den Home-Lock (R2-05) und das Logging, loggt `config.notes` als `warn` und ruft
`startServer()`. Start-Reihenfolge, Beenden und Backend-Wahl normativ in `docs/architecture.md` §3.3.

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `compose.ts` | `startServer(options) → RunningServer`, `StartupError` (`exitCode`), `DEFAULT_FAKE_SPEED`, `resumedSessionId(args)`, Phase 3: `FAKE_FILES_HOME_DIR` (`fake-files`), `fileEntryLookup(registry, profiles)`, `observedPublisher(publisher, observe, log, now?)`, Typen `StartServerOptions`, `RunningServer` | Single-Instance je Home (5), Stores inkl. `profiles.json`, Katalogen und Anhang-Store (3 bei neuerer `schemaVersion`), Backend `fake`/`sdk` (SDK nur hier dynamisch geladen: `import('../backend/sdkBackend')` + `loadAgentSdk()`) mit Claude-Integration über den persistenten Profil-Store und Konsole (Fake-Konsole bzw. PowerShell), Systemintegration (nur produktiver Server), Datei-Dienst, SessionManager mit Host-Befehlen (`profile.*`, `fs.listDirectory`, `file.*`, `files.*`, `editor.detect`) + SyncHub + App, Shutdown-Rahmen + Signale vor `listen` (4 bei `EADDRINUSE`), `HostState.port` nach `listen`, Lockfile mit tatsächlichem Port, im Hintergrund Zugriffsprüfung des Homes (`logHomeAccess`), „Profil testen“ und `SystemIntegration.apply(settings)`; nach einem Fehler dieselbe Aufräumfolge wie beim Beenden |
| `compose.test.ts` | – | In-Process (FakeBackend `speed: 0`, Port 0, Temp-Home, `exit`/Signale injiziert, `--validate=throw`): Lockfile, `dist/web`, Shutdown per Befehl und per Signal, Home-Lock/Zugriffsprüfung, Exit-Codes 3/4/5 (auch neuere `profiles.json`/Kataloge), Aufräumen nach Fehlschlag; Phase 2: `HostState.port`/`systemIntegration`, Host-Befehle über den persistenten Profil-Store (`entryCount` aus der Registry, `profiles.json` nach dem Beenden), `onProfileChanged`, Systemintegration (Seam: `apply` nach `listen` und nach `settings.update`, Warnungen, `onChange`), Fake-Konsole (Übergabe, automatische Rückkehr mit Konsolen-Turn); Phase 3: `fileEntryLookup`, `observedPublisher` (werfender Beobachter blockiert den Hub nie, gedrosseltes `warn`), Ende-zu-Ende `fake:files` → Index → `files.session`/`file.stat` (Zugriff `session`/`cwd`, UNC `PATH_REJECTED`), `file.open` nur protokolliert, `GET /api/file` mit/ohne `Sec-Fetch-Site`, Upload `.xlsx` → Anhang-Ordner + „Fake: received 0 document(s), 1 file(s)“, `files.json` nach dem Beenden |
| `webSnapshot.ts` | `prepareWebRoot({source, home, buildId, log})`, `readWebBuildId`, `parseWebBuildId`, `snapshotDirName`, `WEB_SNAPSHOT_DIR` (`ui`), `WEB_BUILD_INFO_FILE` (`build.json`) | V2-03, ADR-066: der Server liefert eine beim Start fixierte Kopie von `dist/web` aus `PARALLAX_HOME/ui/<buildId>` – ein späterer Build ändert nichts an einem laufenden Server; nur bei passender Build-ID von `dist/web/build.json`, sonst (und im Dev/`dev`-Build) direkt `dist/web` |
| `crash.ts` | `installCrashHandlers({log, shutdown, exit, closeLog?, target?})` | R3-06, ADR-064: `unhandledRejection`/`uncaughtException` → `fatal` im Log und geordneter Shutdown mit Exit 1 (`stop('error', 1)`); vor dem Shutdown-Rahmen bzw. beim zweiten Fehler sofort Exit 1 |
| `bundle.test.ts` | – | esbuild wie `scripts/build-server.ts`: das Bundle importiert das Agent SDK nur dynamisch |

Hub und Transkript-Store validieren ausgehende Werte mit `config.validation` (`--validate` /
`PARALLAX_VALIDATE`, Default `log` auch im Prod-Betrieb, unter Vitest/`NODE_ENV=test` `throw`; R3-05).
`main.ts` installiert nach dem Logging die Crash-Handler (`crash.ts`).

`StartServerOptions`: `config`, `webRoot` (null = keine statische UI), `repoRoot` (Checkout für die
Startbefehle der Systemintegration; fehlt = keine Systemintegration), `systemIntegration`
(Test-Seam), `logging` (wird als Letztes geschlossen), `exit` (Default `process.exit`), `signals`
(Default `process`, null = keine), `fakeSpeed` (Default 1), `findRunning`, `homeLock` (von
`main.ts`, Schritt nach dem Lockfile), `homeAccess(home, signal)` (Default `logHomeAccess`, null =
keine; `signal` bricht eine noch laufende Prüfung beim Beenden ab, V3-15 b), `logger`.
Shutdown-Schritte nach `manager.shutdown()` (der auch `backend.dispose()` ruft und die
Slash-Befehls-Caches flusht): `http → system → profileChecks (R4-13) → files (Index flushen, WP-60)
→ stores → homeAccess (Abbruch) → lock → homeLock`. „Profil testen“ läuft für jedes Profil mit
`checkedAt` null – neue Profile und solche, deren Executable/Env/Config-Ordner sich geändert hat
(R4-06). Der Prozess-Test des Einstiegs liegt in `src/server/main.integration.test.ts`
(tsx-Kindprozess, Launcher-Code → Cookie → WS → Permission → `server.shutdown`, Exit-Codes 3, 4, 5).

Verdrahtung Phase 2 (WP-31 §2.4, WP-32, WP-33, WP-34 §2.4): `openProfileStore` vor der Integration
(`createFakeClaudeIntegration({store, launchEnv: process.env})` – PATH & Co. für die Git-Branch-Suche,
V3-11 – bzw. `createClaudeIntegration({appVersion, profiles})`),
`openCatalogStore` + `createCommandCatalogStore` an den Manager, `store.onChange →
manager.onProfileChanged()`, `hostCommands: [createProfileCommands(…), createFsCommands()]`,
`createSystemIntegration({available: systemIntegrationAvailable(config), repoRoot, home})` mit
`onSettingsChanged → apply`, `extraWarnings → warnings()`, `onChange → publishHostState`,
Konsole `createFakeConsoleLauncher({runMs: 1500, onRun → simulateConsoleTurn})` bzw.
`createConsoleLauncher()`.

Verdrahtung Phase 3 (WP-60, WP-50 §6): `createAttachmentFileStore(home, blobs)` →
`EngineStores.attachments`; `createFileService({home, entries: fileEntryLookup(registry, profiles),
transcripts, settings, launcher, warnings, logger})` – `entries.entry(id)` liefert `cwd` (exakt),
alle `conversationIds` und die `--add-dir`-Ordner des Profils (`parseProfileArgs`; fehlendes Profil
→ keine); `hostCommands: [..., fileService.commands]`; der Manager publiziert über
`observedPublisher(hub, fileService.observeOps)` – der Index sieht jede Op-Charge VOR dem Hub,
ein Fehler dort wird nur (höchstens einmal je Minute, mit Zähler) geloggt und blockiert den Hub nie;
`createApp({files: fileService})` für `GET/HEAD /api/file`. Mit dem FakeBackend immer
`createRecordingOpener()` (loggt `file.open (fake): <ziel> <pfad>`, startet nichts – Dev, E2E,
Verifier), sonst `createSystemLauncher()`. Die echten Fake-Dateien (`fake:files`, `fake:plan`,
`fake:background`) liegen unter `<home>\fake-files` (`FakeBackendOptions.filesRoot`), damit Temp-Homes
von Tests und E2E sie mit aufräumen.

**WP-65:** `hostCommands` bekommt `createLinkCommands(…)` (`link.open`) – mit dem FakeBackend den
aufzeichnenden Öffner (`createRecordingLinkOpener`, startet nichts; Dev und E2E), sonst den Standardbrowser
(`createSystemLinkOpener`, Registry + `spawnGui`).
