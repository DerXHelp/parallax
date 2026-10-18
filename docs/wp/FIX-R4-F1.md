# FIX-R4-F1 – Fix-Paket F1 Server (Ergebnis)

> Auftrag: `docs/wp/FIX-R4.md` §2, Zeile **F1 Server**. Basis `main` = `29f3256`, Branch `fix/r4-f1`
> (Worktree `.worktrees/fix-f1`). Normativ: ADR-121 … ADR-125, Contract-Changelog „R4 (K)“.
> Kein Live-`claude`, kein SdkBackend gegen echtes `claude`, keine echte Konsole, kein HKCU.

## 1. Befunde

| Befund | Stand | Fix (Fundstellen) | Test (Gegenprobe ohne Fix rot) |
|---|---|---|---|
| **R4-01** (BLOCKER) | behoben | Gate-Mengen und `assertEntryGate(s, name)` in `sessions/entryState.ts` (aus `commands.ts` verschoben, dazu `isExternal`); `entryCommand` prüft beim Eingang, die Lock-Körper von `sendPrompt`, `session.resume`, `setArchived(true)`, `switchConversation`, Plan-Freigabe (`decision.respond`) und `openExternal` prüfen **im Lock erneut**; `startRuntime` lehnt externe Einträge ab (`SESSION_EXTERNAL`; deckt auch Retry/Fortsetzen ab). Zweites `openExternal` → `SESSION_EXTERNAL` (nicht idempotent, wie das Gate nach dem Handoff) | `external.integration.test.ts` „R4-01 …“: angehaltenes `open()` (`TestConsoleLauncher.holdNext()`), währenddessen Prompt, Resume, zweites `openExternal`, Archivieren, Wechsel → alle `SESSION_EXTERNAL`, eine Konsole, kein neuer FakeBackend-Start, `runState external`; ohne Fix rot (Prompt startet einen zweiten Schreiber) |
| **R4-02** (BLOCKER, ADR-121) | behoben | `SessionRuntime.scheduled` (`runtime.ts`): ein `tool_call`-Item `ScheduleWakeup`/`CronCreate` (`SCHEDULING_TOOLS`, auch streamend/Subagent) oder ein gesendeter Prompt, der mit `/loop` beginnt (`isLoopPrompt`, case-insensitiv, führende Leerzeichen erlaubt), markiert den Prozess; `sleepEligible` (`manager.ts`) schließt ihn aus, bis der Prozess endet (konservativ: `CronDelete` hebt nicht auf). Log `planned turn – no idle sleep for this process`. `inspect().scheduledTurn` für Tests/Diagnose | `phase2.integration.test.ts` „ADR-121 …“: synthetischer Stream mit `ScheduleWakeup` bzw. `CronCreate` → kein Schlaf-Timer, auch nach Präsenz-/Einstellungswechsel und 120 min; neuer Prozess wieder mit Schlaf; `/loop 40m …` hält wach, „explain /loop“ nicht; ohne Fix rot |
| **R4-03** | behoben | `manager.shutdown()` wartet ab Beginn – parallel zu den Closes – begrenzt (`lifecycleShutdownWaitMs`, Default 10 s, unter dem 20-s-Rahmen) auf laufende Lifecycle-Operationen (`s.lifecycle.idle()`), erst dann Flush; `openExternal` prüft `assertRunning()` direkt vor `launcher.open` | `external.integration.test.ts` „R4-03 …“: Shutdown während `open()` wartet, Handoff übersteht den Neustart (extern + überwacht); Wartezeit begrenzt (virtuelle Uhr); Shutdown vor `open()` → `SERVER_SHUTTING_DOWN`, nichts geöffnet; ohne Fix rot |
| **R4-04** | behoben | `system/console.ts` und `system/autostart.ts` ohne `-ExecutionPolicy Bypass`; `CONSOLE_SCRIPT` setzt vor `Start-Process` `PSModulePath`/`PSExecutionPolicyPreference` auf die Werte der Spec (Träger `PARALLAX_CONSOLE_PSMODULEPATH`/`_PSPOLICY`, case-insensitiv aus `spec.env`) bzw. entfernt sie; geerbte Träger in anderer Schreibweise werden verworfen | `console.test.ts` (Argumentliste, Skriptreihenfolge, Träger), `autostart.test.ts` |
| **R4-05** | behoben | `createConsoleLauncher().state()`: Startzeit (CIM) nur beim ersten Blick und dann alle `CONSOLE_RECHECK_MS` (60 s), dazwischen nur `isProcessAlive`; gleichzeitige Prüfungen teilen eine Abfrage; Fehlschlag wird nicht gemerkt; toter PID → `ended` ohne Abfrage. Option `now` | `console.test.ts` „R4-05 …“ (zählendes `startTime`-Double: 13 Prüfungen in 55 s → 1 Abfrage, nach 60 s erneut, PID-Wiederverwendung → `ended`) |
| **R4-06** | behoben | `profileStore.save`: ändern sich `executable`, `env` oder `configDir` (`profileResolutionKey`, jetzt in `claude/profiles.ts`, auch Schlüssel des Auflösungs-Caches), wird der Prüfstatus verworfen (`checking`, `checkedAt` null); `compose.ts` prüft solche Profile über den bestehenden `onChange`-Weg neu. Name/Farbe/Args/Defaults behalten den Status | `profileStore.test.ts` „R4-06 …“, `compose.test.ts` „R4-06 …“ (Neuprüfung mit neuem `checkedAt`; ohne Fix rot) |
| **R4-07** (ADR-124) | behoben | Kopie `isSecretEnvKey` in `claude/profiles.ts` entfernt, Server importiert `@shared/secrets` (`profiles.ts`, `external.ts`, `consoleCommand.ts`); `registerProfileSecrets` in `claude/integration.ts` registriert die aufgelösten Werte (`${env:…}`) der Secret-Namen des Profils in `launchSpecFor`, `checkProfile` (vor der CLI) und `consoleLaunchFor`; Logger-Freitextmuster nach den Namensteilen (`AWS_BEARER_TOKEN_BEDROCK=`, `GH_TOKEN_CI`, `*_CREDENTIALS`, `*PASSWD`, `ANTHROPIC_CUSTOM_HEADERS`; auch als JSON-Schlüssel, case-insensitiv; nicht `KEYBOARD_LAYOUT`, `TOKENIZER_PATH`, `max_tokens`) | `integration.test.ts` „R4-07 …“ (launch/check), `logger.test.ts` (Tabellen positiv/negativ) |
| R4-08 | behoben | `switchConversation` ruft `cancelContinue` im Lock (vor dem Schließen) | `phase2.integration.test.ts` „R4-08 …“ |
| R4-09 | behoben | `openExternal` ruft `core.checkCwd(cwd)` vor dem Schließen der Query | `external.integration.test.ts` „R4-09 …“ (`CWD_NOT_FOUND`, Prozess läuft weiter); ohne Fix rot |
| R4-10 | behoben | `lib/paths.ts` `checkLinks` läuft nach einem Link im (geprüften) Ziel weiter und liefert den physischen Pfad; relative Ziele weiter unten werden gegen den echten Ordner aufgelöst. `host/fsCommands.ts` `isSafeFolderLink` prüft den ganzen Pfad des Eintrags (`assertNoUnsafeLink(link)`) | `paths.test.ts` „R4-10 …“ (Kette aus R4 → `link_target`), angepasster Kettentest; ohne Fix rot |
| R4-11 | behoben | Autostart „aus“: das Skript liest eine vorhandene `Parallax.lnk` und entfernt sie nur, wenn ihre Argumente `launcher\main.ts` enthalten (`LAUNCHER_MARKER`, auch Marker des Protokoll-Handlers); sonst `foreign` (kein Fehler, keine Warnung) | `autostart.test.ts` |
| R4-12 | behoben | `launcherCommand`: anderes Datenverzeichnis → `--home=<home> --system-integration=on` (vor `--autostart`/`--open`) | `autostart.test.ts` |
| R4-13 | behoben | `compose.ts`: Shutdown-Schritt `profileChecks` (Queue der Hintergrund-Prüfungen, Schritt-Timeout 5 s) vor `stores` | `compose.test.ts` (Schrittfolge aus „shutdown: done“) |
| R4-14 | behoben | `quotedArgBody` in `lib/cmdline.ts` (Basis von `quoteWindowsArg` und `consoleCommand.nativeCommandArg`); `powerShellPath`/`POWERSHELL_UTC_ISO_FORMAT` einmal in `lib/process.ts` (Prozessabfragen nutzen sie, `lib/powershell.ts` re-exportiert – ohne Importzyklus), `homeAccess.ts` und `claude/preflight.ts` nutzen `powerShellPath()`; eine Testlauf-Erkennung `isTestRun(env?)` in `config.ts` für Config, `system/run.ts` (`isTestProcess` = `isTestRun`, unter Vitest jetzt auch mit handgemachtem Env), `sync/hub.ts`, `store/transcripts.ts` | bestehende Tests; `guard.test.ts` angepasst |
| R4-15 | teilweise | Kommentare `manager.ts` (`host.port`), `entryState.ts` (`catalogs`/`commandCatalogs`), `catalogStore.ts`; `config.ts` liest `settings.json` erst nach Größenprüfung (`statSync`) | `config.test.ts` „R4-15 …“. **Zurückgestellt (Koordinator):** ADR-114-Satz zu `commands.json`, architecture §10 (Phase-2-Stand, R0-27 jetzt erfüllt), `sessions/README.md` |
| R4-16 (ADR-125) | behoben | `resolveAttachments`: Summe der Rohbytes ≤ `LIMITS.attachmentsTotalBytes`, sonst `PAYLOAD_TOO_LARGE {bytes: Summe, max}` (ohne `blobId`), geprüft beim Laden, base64 erst danach | `phase2b.integration.test.ts` (create/sendPrompt über der Grenze, genau an der Grenze ok) |
| **R4W-07** (ADR-122) | behoben | `toastShowOptions(…, windowNotified)`: `silent`, wenn ein Fenster dieselbe Meldung bekommt (`planned.clientId !== null`) | `nativeToasts.test.ts`, `phase2b.integration.test.ts` (Fenster ohne Web Notifications: `notify in_app` + stummer Toast) |
| **R4W-08** (ADR-123, Server) | behoben | `consoleCommandText`: Secret-Namen als `$env:NAME=[Net.NetworkCredential]::new('', (Read-Host 'NAME' -AsSecureString)).Password` (`secretPrompt`), übrige Werte bleiben | `consoleCommand.test.ts`, `external.integration.test.ts` (Secret nie im Kopierbefehl) |
| R4W-09 (Server) | behoben | siehe R4-07 | – |
| R4W-21 (Server) | behoben | `config.ts` nutzt `DEFAULT_PORT` aus `@shared/model` (eigene Konstante entfernt) | `config.test.ts` |
| V3-11 | behoben | Fake-Integration: Option `launchEnv` → Launch-Specs mit `FAKE_LAUNCH_ENV_KEYS` (PATH, PATHEXT, SystemRoot, windir, USERPROFILE, HOMEDRIVE/-PATH, TEMP/TMP – keine Secrets, keine Session-Marker); `compose.ts` übergibt im Fake-Server `process.env` (Tests/Harness ohne). `readGitBranch`: scheitert `rev-parse --abbrev-ref HEAD` (frisches Repo ohne Commit), Rückfall `git branch --show-current` | `backend/fake/integration.test.ts`, `gitBranch.test.ts` |
| V3-15 (a) | Doku | Handles nicht vererben geht in Node ohne native Hilfe nicht (libuv vererbt alle vererbbaren Handles, kein `SetHandleInformation`); Hinweis in `launcher/README.md` (Datei statt Pipe, nur auf den Launcher-Exit warten, PowerShell `-PassThru` + `WaitForExit()` statt `-Wait`) | – |
| V3-15 (b) | behoben | `runFile` mit `signal` (Abbruch beendet den Baum wie der Timeout, `timedOut: true`; schon abgebrochen → nichts gestartet); `checkHomeAccess`/`logHomeAccess` mit `signal`; `compose.ts` bricht die Prüfung im Schritt `homeAccess` ab statt bis 5 s zu warten (`homeAccess(home, signal)`) | `process.test.ts` (echter Prozessbaum), `homeAccess.test.ts`, `compose.test.ts` (keine „step did not complete“) |

## 2. Entscheidungen

1. **R4-01:** ein zweites `session.openExternal`, das während des ersten auf den Lock wartete, antwortet
   `SESSION_EXTERNAL` (wie jeder Befehl nach dem Handoff) statt idempotent `{pid}` – die UI zeigt den
   bekannten Fehlertext, es entsteht nie eine zweite Konsole.
2. **R4-03:** die Wartezeit läuft ab Shutdown-Beginn parallel zu den Closes (Gesamtdauer = Maximum, nicht
   Summe), Default 10 s – ein Handoff, dessen PowerShell länger braucht, wird danach noch in den Speicher
   geschrieben, erreicht aber evtl. die geschlossenen Stores nicht (wie vorher, nur seltener; Log
   `lifecycle operations still running`).
3. **ADR-124/R4-06:** registriert werden die aufgelösten Werte der **Profil**-Secret-Namen (nicht jedes
   Secret der Server-Umgebung – Pfade in `*_KEY_PATH`-Variablen würden sonst Logs unlesbar machen); der
   Prüfstatus fällt nur bei `executable`/`env`/`configDir` zurück (dieselbe Menge wie der
   Auflösungs-Cache; `args` ändern weder Version noch Anmeldung).

Weitere: `PAYLOAD_TOO_LARGE` der Summe ohne `blobId` (ADR-125: „Params im bestehenden Schema“);
`isTestProcess({})` ist unter Vitest jetzt `true` (strenger, R6); Autostart-Entfernen einer fremden
Verknüpfung ist kein Fehler (wie beim fremden Protokoll-Handler).

## 3. Checks

| Schritt | Ergebnis |
|---|---|
| `pnpm exec tsc -b` | grün |
| `pnpm exec eslint src/server scripts/preflight.ts --max-warnings=0` | grün |
| `pnpm exec vitest run src/server` | grün, 109 Dateien / 2277 Tests (111 s) |
| `pnpm check` (Stand `631736a`) | typecheck ✓, lint ✓, Vitest **3587/3588** – `system/guard.test.ts` „every server test … injects its runner“ lief in **20,2 s** in den 20-s-Timeout (isoliert 0,3 s; paralleler Lauf mit F2–F4 auf demselben Rechner, Virenscanner) → Befund **F1-FLAKE-1** unten |
| `tsc -b` + `pnpm test` nach der Entschärfung | grün, Vitest 200 Dateien / **3588/3588** (226 s) |
| `pnpm build` | grün (`0.0.0+631736a4335b`) |

**F1-FLAKE-1 (instabiler Test, gemeldet):** Der statische Check in `system/guard.test.ts` las rund
110 Testdateien nacheinander; unter Volllast überschritt die Summe der Lesezeiten das Test-Timeout.
Nicht durch dieses Paket verursacht (keine neuen Testdateien im gelesenen Umfang, Test unverändert
bis auf die Erwartung `isTestProcess({})`). Entschärft ohne Zeitlimit-Änderung: die Dateien werden
gleichzeitig gelesen (`Promise.all`). Bitte im Koordinator-Lauf beobachten (`docs/wp/FLAKES.md`).

Gegenproben (Fix-Dateien per `git stash` zurückgesetzt, Tests unverändert): R4-01/-02/-03/-09 – 8 Tests
rot; R4-10 – 2 Tests rot. E2E nicht ausgeführt (Paket F5); keine Konsolen-/Launcher-E2E betroffen außer
dem Kopierbefehl (Text ändert sich nur bei Secret-Namen).

## 4. Live-Prüfpunkte für WP-41

- **L6 Konsole (R4-01/-04/-05):** direkt nach „In Konsole öffnen“ Enter im Composer bzw. erneuter
  Menüklick → Fehler „extern“, nur **eine** Konsole; in der Konsole `$env:PSExecutionPolicyPreference`
  leer, `$env:PSModulePath` wie in einer frisch geöffneten Konsole (PowerShell 7: Module laden),
  `$env:CLAUDECODE` leer; Task-Manager: während offener Konsole keine Dauer-`powershell.exe` (höchstens
  alle 60 s kurz eine CIM-Abfrage); Rückkehr ≤ ~5 s nach dem Schließen.
- **R4-03:** „Server beenden“ unmittelbar nach „In Konsole öffnen“ → nach dem Neustart ist der Eintrag
  extern und kehrt nach dem Schließen der Konsole zurück (kein zweiter Schreiber).
- **ADR-121:** Leerlauf-Schlaf kurz (z. B. 5 min) einstellen; `/loop 10m …` und ein `ScheduleWakeup`
  („prüfe in 20 min erneut“) → Session bleibt wach, Log `planned turn`; ohne Plan schläft sie ein.
- **ADR-123:** „Konsolenbefehl kopieren“ mit Profil-Secret → Zwischenablage ohne Wert; Einfügen in
  Windows PowerShell 5.1 **und** PowerShell 7 fragt verdeckt nach dem Wert, `claude` startet angemeldet.
- **ADR-122:** Fenster ohne Web-Notification-Recht + nativer Toast → nur **ein** Ton (der des Fensters).
- **R4-06:** `configDir` eines Profils ändern → Status „wird geprüft“, danach das neue Ergebnis.
- **R4-11/R4-12:** eigene `Parallax.lnk` (z. B. auf `parallax.cmd`) bleibt bei Autostart „aus“;
  `--system-integration=on` + Temp-Home: Verknüpfung und Protokoll-Befehl enthalten
  `--system-integration=on`, der so gestartete Server hat Integration (Rückbau dort möglich).
- **V3-11:** Git-Branch im Fake- und SDK-Server sichtbar, auch in einem frischen Repo ohne Commit.
- **ADR-125:** sieben große Screenshots (> 20 MB zusammen) → Fehler am Chip (Client, F4) bzw.
  `PAYLOAD_TOO_LARGE` vom Server.
- **V3-15 (b):** Server kurz nach dem Start beenden → keine Warnung `homeAccess` im Log.

## 5. Wünsche an den Koordinator

- **READMEs mit mehreren Ownern** nachziehen:
  - `src/server/sessions/README.md`: `entryState.ts` (`assertEntryGate`, `isExternal`,
    `ARCHIVED_ALLOWED`/`EXTERNAL_ALLOWED`, `EntryCommand(Name)`; Option `lifecycleShutdownWaitMs`),
    `runtime.ts` (`SCHEDULING_TOOLS`, `isLoopPrompt`, `SessionRuntime.scheduled`/`markScheduled`),
    `manager.ts` (`inspect().scheduledTurn`, Shutdown wartet auf Lifecycle), `nativeToasts.ts`
    (`toastShowOptions(…, windowNotified)`), `attachments.ts` (Summengrenze), `testing/consoleLauncher.ts`
    (`holdNext`), `lib/gitBranch.ts` (Rückfall `branch --show-current`); dazu die R4-15-Punkte
    (Manager mit `onProfileChanged`/`externalChecksDone`, Notifier `isWatchedByFocusedClient`/`ChannelRules`,
    `entryState.ts` `settingsSleepPolicy`/`assertWithoutWork`).
  - `src/server/lib/README.md`: `cmdline.ts` `quotedArgBody`; `process.ts` `runFile` Option `signal`,
    `powerShellPath`/`POWERSHELL_UTC_ISO_FORMAT` (Definition jetzt hier, `powershell.ts` re-exportiert);
    `logger.ts` Muster nach `@shared/secrets`; `homeAccess.ts` `signal` + `powerShellPath()`;
    `paths.ts` R4-10.
  - `src/server/README.md`: `config.ts` exportiert `isTestRun(env?)`, `DEFAULT_PORT` kommt aus `@shared/model`.
  - `src/server/backend/README.md`: Fake-Integration `launchEnv` (Details in `backend/fake/README.md`).
- **Doku:** architecture §10 (Phase-2-Stand; R0-27/Wakeup-Erkennung erfüllt durch ADR-121), ADR-114-Satz zu
  `entries/<id>/commands.json` (neuere Datei = kein Cache, wird überschrieben), ADR-104 ergänzen
  (Konsole ohne `-ExecutionPolicy`, PS-eigene Variablen auf Spec-Werte; Gate auch im Lock; Shutdown wartet
  begrenzt), `docs/progress.md`.
- **F2 (Web):** Hinweistext beim Kopieren (Namensraum `navigation`) nennt, dass geheime Werte in der Konsole
  abgefragt werden (ADR-123) – Server liefert das seit diesem Paket.
- **F5 (E2E):** optional ein E2E-Fall Git-Branch im Fake-Server (Temp-Repo mit `git init`), da die
  Launch-Specs des Fake-Servers jetzt PATH tragen.
