# src/server/system – Windows-Integration (Phase 2)

Owner: **WP-33** (außer `ports.ts`: Koordinator, eingefroren). Auftrag: `docs/wp/WP-33.md`.

Sichtbare Konsole für `claude --resume <id>` (ADR-104), Autostart-Verknüpfung (ADR-110) und der
optionale Protokoll-Handler `parallax:` (ADR-109). Nur der produktive Server (Standard-Datenordner,
SDK-Backend, kein `--dev`; `--system-integration=on` erzwingt es – `systemIntegrationAvailable` in
`config.ts`) ändert HKCU oder den Autostart-Ordner – Tests, Dev- und Fake-Server nie.

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `ports.ts` | Port `ConsoleLauncher`, `ConsoleProcess`, `ConsoleOpenResult`, `SystemIntegration` (nur Typen) | Koordinator |
| `console.ts` | `createConsoleLauncher({ run?, platform?, timeoutMs?, isAlive?, startTime?, now? })`, `CONSOLE_SCRIPT`, `CONSOLE_ENV`, `CONSOLE_TIMEOUT_MS`, `CONSOLE_START_TOLERANCE_MS`, `CONSOLE_RECHECK_MS`, `parseConsoleOutput` | versteckte PowerShell (System32, ohne Shell, **ohne** `-ExecutionPolicy`, R4-04) mit konstantem Skript (`-EncodedCommand`): `Start-Process -PassThru` öffnet die Konsole; Daten nur in `PARALLAX_CONSOLE_EXE/_ARGS/_CWD` (das Skript entfernt sie vor dem Start), `PSModulePath`/`PSExecutionPolicyPreference` werden auf die Werte der Spec gesetzt (`_PSMODULEPATH`/`_PSPOLICY`, sonst entfernt), Rest = `ConsoleLaunchSpec.env`; Ausgabe `pid=…;start=…`, Fehler → Exit 3 → `failed`. `state`: `isProcessAlive` + Startzeit ± 5 s – die CIM-Abfrage nur beim ersten Blick und dann alle `CONSOLE_RECHECK_MS` (60 s, R4-05), dazwischen nur `isProcessAlive`; Abfragefehler → `unknown` |
| `fakeConsole.ts` | `createFakeConsoleLauncher({ runMs?, onRun?, now? })`, `FAKE_CONSOLE_RUN_MS` (1,5 s), `FAKE_CONSOLE_FIRST_PID` (50 000) | `--backend=fake`/E2E: öffnet nichts, synthetische PIDs, `running` bis `runMs`, dann `ended` |
| `autostart.ts` | `launcherCommand(repoRoot, extra, { home?, execPath?, realpath? })` → `StartCommand`, `autostartLinkPath(env)`, `createAutostartShortcut`, `removeAutostartShortcut`, `autostartLinkExists`, `AUTOSTART_SCRIPT`, `AUTOSTART_ENV`, `AUTOSTART_LINK_NAME`, `LAUNCHER_MARKER`, `FOREIGN_SHORTCUT` | `Parallax.lnk` in `<APPDATA>\…\Startup` per PowerShell + `WScript.Shell` (Skript konstant, Daten per Env, ohne `-ExecutionPolicy`): Ziel `realpath(process.execPath)`, Argumente `windowsCommandLine([cli.mjs, --tsconfig, tsconfig.json, launcher\main.ts, (--home=…, --system-integration=on,) --autostart])` (R4-12), Arbeitsordner = Repo, Fenster minimiert (7); eine vorhandene Verknüpfung wird vor **beiden** Aktionen gelesen: ohne `launcher\main.ts` in den Argumenten gehört sie dem Nutzer/einem anderen Programm und bleibt – Entfernen meldet `ok` (R4-11), Anlegen lehnt mit `reason: 'foreign'` ab (CR2-03, nie ersetzt) |
| `protocol.ts` | `protocolCommand(command)`, `registerProtocolHandler`, `unregisterProtocolHandler`, `isOwnCommand`, `regKeyReader(run)`, `RegKeyRead`, `RegKeyReader`, `PROTOCOL_KEY`, `PROTOCOL_COMMAND_KEY`, `FOREIGN_HANDLER` | `HKCU\Software\Classes\parallax` per `reg.exe` (`lib/registry.ts` `regAddValue`/`regDeleteKey`): zuerst `shell\open\command` = `"<node>" <args…> --open "%1"`, dann `URL:Parallax` und `URL Protocol` leer; fremd (nie überschrieben, nie entfernt, `foreign`) ist ein Schlüssel, dessen Befehl `launcher\main.ts` nicht enthält **oder** der gar keinen `shell\open\command` hat. CR2-01: `regKeyReader` (`reg query <key> /ve`) unterscheidet per Exit-Code „vorhanden“ (0), „fehlt“ (1) und „fehlgeschlagen“ (Timeout, Startfehler, anderer Exit) – eine fehlgeschlagene Abfrage schreibt/entfernt nichts und wird zur Warnung |
| `index.ts` | `createSystemIntegration({ available, repoRoot, home, run?, platform?, env?, now?, logger?, command? })` → `SystemIntegration`, `AUTOSTART_WARNING_ID`, `PROTOCOL_WARNING_ID` | Abgleich mit `settings.autostart.enabled` und `settings.notifications.openOnClick` (nacheinander, nie parallel, nie werfend; ein erreichter Zustand wird nicht erneut angewandt); Fehler → Host-Warnungen `AUTOSTART_FAILED`/`PROTOCOL_HANDLER_FAILED` (`system:autostart`/`system:protocol`), danach `onChange`; `toastLaunchUri(entryId)` nur bei registriertem Handler; anderer Datenordner → `--home=<home> --system-integration=on` in beiden Befehlen (R4-12) |
| `run.ts` | `systemRunner(run?)`, `systemEnv(env?)`, `isTestProcess` (= `isTestRun` aus `config.ts`, R4-14), `TEST_RUN_REFUSAL`, `SystemOpResult` | R6-Schutz: ohne injiziertes `run`/`env` verweigert ein Testlauf (Vitest, `NODE_ENV=test`) jeden Aufruf, bevor etwas startet (leere Umgebung → kein echtes `APPDATA`) |

**Verdrahtung (WP-40):** `createSystemIntegration({ available: systemIntegrationAvailable(config),
repoRoot, home: config.home })`, `apply(settings)` beim Start und nach jedem `settings.update`,
`warnings()` in `HostState.warnings`, `onChange` → `publishHostState`; Konsole:
`config.backend === 'fake' ? createFakeConsoleLauncher() : createConsoleLauncher()`. Der Toast
(`lib/toast.ts`) bekommt `launchUri: integration.toastLaunchUri(entryId)` und `silent`.

**Tests:** nur mit injiziertem `run` (Fake) und Temp-`APPDATA`; `guard.test.ts` prüft, dass ohne
Injektion nichts gestartet wird (Spawn-Falle) und jeder Test der Integration sein `run` injiziert.
Live (sichtbares Fenster, `.lnk`, HKCU, Toast-Klick) prüft erst WP-41 (L6, L8, L10).
