# WP-87b – Orchestrierung des Versionswechsels

Auftrag: `docs/wp/WP-87.md` §2.2 (dazu §0.2 E1–E3, §1.7, §3), Branch `wp/87b`. Läuft immer als Code der **alten**
Version; deshalb bleiben Flags, Handschlag und Formate über Versionsgrenzen stabil (§1.7).

## Ergebnis

Geändert bzw. neu in `src/server/launcher/`: `applyUpdate.ts` (neu, + Test), `args.ts`, `cli.ts`, `main.ts`,
`launcher.ts`, `shutdown.ts`, `backupStep.ts` (jeweils + Test), `README.md`. Keine Änderung an Contracts, Ports,
`install/**`, `store/**`, `lib/**` oder `update/**`; keine neue Abhängigkeit.

### Schnittstellen

- **`args.ts`:** `LauncherArgs.applyUpdate: ApplyUpdateArgs | null` (`{version, restore, waitPid}`); Flags
  `--apply-update=<v>`, `--restore`, `--wait-pid=<pid>` (jeweils auch mit Leerzeichen statt `=`), Konstanten aus
  `update/handoff.ts`. Problem (Exit 2) bei `--apply-update` ohne `--install-root` oder ohne gültiges `--wait-pid`, mit
  ungültiger Version (zod `releaseVersionSchema`), zusammen mit `--open`/`--autostart`/`--print-url`, sowie bei
  `--restore`/`--wait-pid` ohne `--apply-update`. `--wait-pid` nur als Dezimalzahl (`1e3` zählt nicht).
- **`cli.ts`:** `LauncherCliDeps.applyUpdate(request): Promise<number>` (Pflicht). Nach der Argumentprüfung und vor
  `--open`/`launch`: `loadConfig` wie beim normalen Start, dann `ApplyUpdateRequest` mit `serverArgsFor(config)` +
  `--install-root=<root>`, `readyTimeoutMs(env)`, `toasts`, `notes`. Ein Fehler in Argumenten oder Konfiguration eines
  Aufrufs mit `--apply-update` schreibt sofort `PARALLAX-APPLY-FAILED spawn` auf stdout (der Server wartet sonst bis
  zur Frist) und endet mit Exit 2.
- **`main.ts`:** im Orchestrator-Modus `logger.level = 'silent'` und ein leerer `error`-Handler auf stdout/stderr –
  nach dem Handschlag schließt der Server die Pipe, ein Schreibfehler darf den Prozess nicht beenden. Der Handschlag
  wird mit Callback geschrieben; scheitert das Schreiben von `READY`, wird nichts umgeschaltet.
- **`launcher.ts`:** `export launchLocked(options, deps)` (das bisherige innere `launch`, unverändert);
  `runLauncher` ruft es unter der Start-Sperre. `tryDirectoryLock` ist exportiert. `createNodeLauncherDeps` gibt im
  Paket-Modus `installedVersion` an `backupBeforeStart` weiter.
- **`shutdown.ts`:** `createServerShutdown({sparePids?: () => readonly number[]})` (gelesen erst beim Abräumen, gilt
  nur für das Standard-`forceKill`), `killChildProcessTrees({except?: readonly number[]})`.
- **`backupStep.ts`:** Signatur jetzt `backupBeforeStart(home, buildId, {now?, installedVersion?, writeMarker?})`
  (Optionsobjekt statt `now` als drittes Argument). Im Paket-Modus schreibt eine **gespeicherte** Sicherung (nicht
  bei leerem/frischem Datenordner) den Marker `installed`: `from = {version: versionOfBuildId(alt), buildId: alt}`,
  `to = {version: release.version, buildId}`, `backupDir`. Ein Fehler beim Marker ändert das Ergebnis nicht.
- **`applyUpdate.ts`:** `runApplyUpdate(request, deps) → Exit-Code` (0 = neue Version läuft, 1 = sonst; wirft nie),
  `ApplyUpdateDeps` (alle Seiteneffekte), `createNodeApplyUpdateDeps({own, home, handshake, env?, log?})`,
  `openUpdateLog(home, now)`, `failureNotification(lang, version, log)`, `restartFailedReason(error)`.

### Ablauf (§2.2, Schritte 1–11) und Entscheidungen im Detail

1. Sperren `launch` (Datenordner), dann `install` (Stammordner) über `pollLock`.
2. Lockfile: `ok`, `pid = --wait-pid`, `buildId` = eigene `release.json` (sonst `lock`); Ziel: `readSignedRelease`
   mit `updateEndpoints(env).releaseKeys` (Test-Build: Test-Schlüssel), Version stimmt, `checkNodeVersion`,
   `package.json` des SDK vorhanden (sonst `package`); Restore-Modus: `findBackup(home, {from: ziel, to: eigene})`
   (sonst `backup`). Ohne eigene `release.json` (Klon) oder Ziel = eigene Version: `package`. Unerwartetes: `spawn`.
3. `PARALLAX-APPLY-READY`.
4. Warten (Poll 250 ms, ≤ `serverExitMs`), bis die Home-Sperre frei ist (Versuch, sofort freigeben) und `waitPid` nicht
   mehr lebt. Danach nur bei `processStartTime(waitPid) < lock.startedAt` beenden; unbekannte Startzeit oder jüngerer
   Prozess (wiederverwendete PID) → nie. Anschließend ≤ `killGraceMs`; am Ende entscheidet allein die Home-Sperre.
   Belegt: Marker `failed (lock)`, Benachrichtigung, Exit 1, nichts umgeschaltet.
5. `verifyVersion` (+ gleiche Build-ID wie in Schritt 2); Fehler → Rückweg ohne Daten/Umschalten, `package`.
6. `createBackup(home, {from: readLastBuildId ?? eigene, to: ziel})`, Restore-Modus `restoreBackup(gefunden)`,
   `writeLastBuildId(ziel)`; Fehler → Rückweg (`backup`), mit dem neuen Sicherungsordner, falls schon angelegt.
   `pruneBackups` danach; sein Fehler wird nur protokolliert.
7. Marker `pending` (mit `backupDir`, `log`), `readCurrent` (für den Rückweg), dann `switchVersion(root, v,
   {previous: eigene})`; Fehler → Rückweg (`package`), auch bei halbem Umschalten.
8. `launchLocked({home, port, serverArgs, build: true, printUrl: false, openWindow: false, installRoot, backend,
   readyTimeoutMs})` mit `createNodeLauncherDeps({repoRoot: versions\<v>, release: ziel, workDir: root, home,
   serverScript, out: log})`, `backupBeforeStart → unchanged`, `startServer` meldet PID und Ende. Nach dem Erfolg wird
   die Build-ID aus dem Lockfile gelesen: `existing` mit fremder Build-ID → `port`, `existing` mit der Ziel-Build-ID
   gilt als Erfolg.
9. `cleanupVersions(root, [v, eigene])`, Exit 0.
10. Rückweg: Baum des gestarteten Servers beenden (nur wenn er noch lebt), ≤ `killGraceMs` auf die Home-Sperre warten,
    **dann** Marker `failed` (siehe Abweichung 4), `restoreBackup(backupDir)` (falls angelegt),
    `writeLastBuildId(eigene)`, `restoreCurrent(before)` (falls umgeschaltet), eigene Version per `launchLocked`
    (Ordner = `repoRoot` des laufenden Launchers). Ergebnis Exit 1.
11. Scheitert ein Schritt des Rückwegs (Home-Sperre bleibt belegt, Einspielen, `current.json`, Start): die folgenden
    Schritte entfallen, Benachrichtigung (`lib/toast.ts`, Tag `parallax-update`, Text deutsch oder englisch nach
    `settings.json` → `language`) mit dem Log-Pfad; bei `--toasts=off` nur das Protokoll. Exit 1.

Abbildung `LauncherError.reason` → `UpdateRestartFailedReason`: `server_timeout` → `timeout`, `server_exited` →
`exited`, `store_too_new` → `store_too_new`, `port_in_use`/`port_denied`/`backend_mismatch` → `port`,
`package_damaged` → `package`, alles andere (z. B. `server_start_failed`) → `spawn`.

Protokoll: `<home>\logs\update-<YYYYMMDD-HHmmss>.log` (Ortszeit wie die Versionsordner), synchron Zeile für Zeile mit
ISO-Zeitstempel angehängt; die fünf neuesten `update-*.log` bleiben. Auf stdout nur die Handschlag-Zeile.

### Abweichungen vom Entwurf (bitte prüfen)

1. **Kein `killProcessTree(waitPid)`:** Der Orchestrator ist Kind des alten Servers (auch `detached` behält die
   `ParentProcessId`), `taskkill /PID <server> /T` beendete ihn mit. `killOldServer` beendet deshalb jeden
   Kindbaum des alten Servers einzeln mit `killProcessTree` (außer dem eigenen Prozess und Kindern, die älter als der
   Server sind) und danach nur den Serverprozess per `process.kill(pid, 'SIGKILL')` (= `TerminateProcess`). Kann die
   Kinderliste nicht gelesen werden, wird nur der Server beendet (verwaiste `claude`-Prozesse räumt der nächste
   Serverstart über `processes.json`).
2. **Frist vor dem Handschlag 15 s statt `lockMs` je Sperre:** Der Server wartet ab dem Spawn nur `handshakeMs`
   (20 s). Ein später `READY` an einen Server, der schon aufgegeben hat und weiterläuft, führte nach `serverExitMs`
   zum Beenden dieses laufenden Servers. Beide Sperren teilen sich daher `PRE_HANDSHAKE_BUDGET_MS = handshakeMs − 5 s`.
3. **`--wait-pid` ist Pflicht** zu `--apply-update` (Schritt 2 vergleicht es mit dem Lockfile).
4. **Marker `failed` vor dem Einspielen statt danach:** erst nachdem der neue Server beendet und die Home-Sperre frei
   ist (ein noch startender neuer Server würde den Marker sonst beim Start verbrauchen), aber vor dem Einspielen, damit
   er auch bei gescheitertem Rückweg liegt („Marker bleibt failed“).
5. **Rückweg bricht beim ersten Fehler ab:** keine Daten zurück, solange die Home-Sperre belegt ist; kein Start der
   alten Version auf nicht zurückgespielten Daten. `current.json` zeigt dann ggf. noch auf die neue Version.
6. **`current.json` fehlte oder war kaputt** vor dem Umschalten: Der Rückweg schreibt `{version: eigene, previous:
   null}` statt die Datei zu löschen (`restoreCurrent(null)` löschte sie, `start.mjs` startete dann nichts).
7. **Marker `installed`** nur, wenn eine Sicherung tatsächlich bleibt (`saved`); ein frischer Datenordner ohne Stores
   zeigt kein „Aktualisiert auf …“.

## Für WP-89 (Integration, Koordinator)

- **`compose.ts`:** `createServerShutdown({…, sparePids: () => { const pid = update.orchestratorPid(); return pid
  === null ? [] : [pid]; }})`. Ohne das beendet das Abräumen nach `SHUTDOWN_SWEEP_GRACE_MS` den Orchestrator.
- **Launcher-Bundle:** `dist/launcher.js` enthält jetzt `update/endpoints.ts` (Schlüssel), `update/marker.ts`,
  `install/install.ts` und `lib/toast.ts`. `scripts/build-server.ts` muss `__PARALLAX_UPDATE_TEST__` auch für das
  Launcher-Bundle setzen (`'false'` normal, `'true'` in `dist-e2e/launcher.js`), und `bundle.test.ts` sollte auch
  `dist/launcher.js` auf `PARALLAX_TEST_` prüfen. Im Test-Build nimmt der Orchestrator die Schlüssel aus
  `PARALLAX_TEST_RELEASE_KEYS` (Umgebung des Servers).
- **E2E:** Der Orchestrator braucht im Test die Umgebung des Servers (`PARALLAX_TOASTS=off` bzw. `--toasts=off`
  verhindert die Benachrichtigung; `PARALLAX_UPDATE_READY_TIMEOUT_S` für B-kaputt kurz halten, ≥ 10). Prüfbar:
  `<home>\logs\update-*.log`, `update-result.json`, `current.json` byte-gleich nach dem Rückweg.

## Für 87a (Update-Dienst)

- Läuft `handshakeMs` ab, sollte der Dienst den Orchestrator beenden (`killProcessTree(child.pid)`), damit kein später
  `READY` ankommt; der Orchestrator antwortet zwar spätestens nach ≈ 15 s, aber ein sehr langsamer Start (Virenscanner)
  bleibt denkbar.
- Der Orchestrator schreibt auf stdout nur die eine Zeile; stderr nur bei Argumentfehlern (vor dem Handschlag).
- Exit 2 = Argumente/Konfiguration (mit `FAILED spawn`), Exit 1 = abgelehnt bzw. gescheitert.

## Prüfung

`pnpm exec vitest run src/server/launcher`: 14 Dateien, alle grün (neu: `applyUpdate.test.ts` mit 33 Tests, davon
einer mit echten `switchVersion`/`restoreCurrent`/`createBackup`/`restoreBackup` in Temp-Ordnern; ergänzt `args`,
`cli`, `shutdown` – Standard-Abräumen mit `sparePids` über gemocktes `lib/process` –, `backupStep`). Echte Prozesse
nur im bestehenden `launcher.integration.test.ts`. ESLint und Prettier auf allen geänderten Dateien sauber.

## Folgearbeiten

- `lib/process.ts` (nicht in 87b): ein Helfer „Prozessbaum beenden außer PID x“ bzw. `taskkill /PID <pid> /F` ohne
  `/T`, damit `killOldServer` nicht auf `process.kill` ausweichen muss.
- Live-Prüfung (§4): ob ein Job-Objekt mit „kill on close“ den Orchestrator mit dem alten Server beendet (§3 Punkt 10).
