# WP-87a – Update-Dienst

Auftrag: `docs/wp/WP-87.md` §2.1 (dazu §0.2 E1/E5, §1.3–§1.7), Branch `wp/87a`. Ergänzung des Koordinators: Handschlag
ohne gültige Zeile → Orchestrator beenden, dann `UPDATE_RESTART_FAILED {version, reason: 'handshake'}`.

## Ergebnis

Neu in `src/server/update/` (jeweils mit `*.test.ts` daneben):

| Datei | Inhalt |
| --- | --- |
| `fetch.ts` | Abrufe mit eigenen Weiterleitungen (≤ 5, je `https:` + `isAllowedDownloadUrl`, Loopback-`http:` nur im Test-Build, keine Anmeldedaten), Größenlimit, Fristen; `fetchBytes`, `downloadFile` (gestreamt, SHA-256, Fortschritt) |
| `latest.ts` | `latest.json` + `.sig` prüfen (`latestInfoSchema`, Signatur, `url = assetUrl(v)`, Downgrade-/Prerelease-Schutz), signierten `CHANGELOG.md` laden (§1.6) |
| `zip.ts` | `tar.exe -t -v` auswerten (Wurzel genau `parallax-<v>/`, kein `..`/absolut/Laufwerk/Backslash, keine Links, ≤ 20 000 Einträge, ≤ 512 MiB), `tar.exe -x` |
| `prepare.ts` | Vorbereiten (GitHub, 7 Schritte unter der Sperre `install`) und „Aus Datei“; Fehlerabbildung `prepareErrorPayload` |
| `previous.ts` | vorige Version aus `current.json` (`needsRestore`, `backupAt`), `downgradeOf` für Pakete aus Datei |
| `changelog.ts` | Abschnitte für „Was ist neu“ (installiert / angeboten, Rückfall auf `notes`) |
| `notices.ts` | feste Textdateien (`LICENSE`, `THIRD_PARTY_NOTICES.md`) ≤ 16 MB |
| `stateFile.ts` | `<home>\update-state.json` (`{schemaVersion: 1, dismissedVersion}`) |
| `apply.ts` | Start des Orchestrators und Handschlag (`handOver`) |
| `service.ts` | `createUpdateService(options, seams?)` → `UpdateService` |
| `routes.ts` | `registerUpdateRoutes(app, update, {maxBytes?})` |
| `testing.ts` | `createFakeUpdateService()` für WP-89 und Routen-Tests |
| `testRelease.ts` | Test-Hilfe: Fake-Release-Server hinter injiziertem `fetch`, signierte `latest.json`, Zips per `tar.exe` |

Keine Änderung an Contracts, Ports, `install/**`, `store/**`, `lib/**` oder der Verdrahtung; keine neue Abhängigkeit.

## Was WP-89 aufrufen muss

1. **Erzeugen** (einmal je Start, nach dem Laden der Stores – liest und löscht den Marker):
   `const update = await createUpdateService({home, installRoot, repoRoot, release, instance, serverArgs:
   serverArgsFor(config), settings: () => <aktuelle Settings>, requestRestart, logger})`. `installRoot`/`release` null
   im Klon → Status `unsupported`, jeder Befehl `UPDATE_NOT_PACKAGED`. `requestRestart` setzt das Neustart-Flag
   (Close 4504) und stößt das geordnete Herunterfahren an; der Dienst ruft es per `setImmediate` nach dem Ack.
2. **Host-Befehle:** `update` ist ein `HostCommandHandler` (`names = UPDATE_COMMAND_NAMES`) → in die Liste der
   Host-Befehle.
3. **HostState:** `app: update.app()`, `update: update.state()`; `update.onChange(() => publishHostState())`
   (Status sofort, Fortschritt höchstens alle 500 ms).
4. **Start:** `update.start()` nach `listen` und Lockfile (erste automatische Prüfung 60 s später).
5. **Einstellungen:** bei jeder Änderung `update.settingsChanged(next)` (nur `updates.check` zählt).
6. **Routen:** `await registerUpdateRoutes(app, update)` in dem Kontext, in dem die Guards schon hängen (der Upload
   liegt in einem eigenen gekapselten Scope mit nur einem Stream-Parser). Guard-Klassen in `origin.ts`:
   `POST API_PATHS.updatePackage` → `mutation`, `GET API_PATHS.changelog` und `GET API_PATHS.notices` → `file`.
   Eine fremde Content-Type im Upload-Scope wirft Fastifys 415 (`FST_ERR_CTP_INVALID_MEDIA_TYPE`) – der vorhandene
   Fehler-Handler von `http/app.ts` bildet ihn auf `UNSUPPORTED_MEDIA_TYPE` ab. Das globale `bodyLimit` gilt für
   Stream-Parser nicht; das Limit (200 MiB, gezählt und laut `content-length`) prüft die Route selbst.
7. **Herunterfahren:** `await update.close()` als eigener Schritt vor den Stores (bricht Prüfung/Download/Vorbereitung
   ab, wartet ≤ 10 s; ein laufender Wechsel wird nicht abgebrochen). `createServerShutdown({sparePids: () => { const
   pid = update.orchestratorPid(); return pid === null ? [] : [pid]; }})` – der Orchestrator überlebt das Abräumen.
8. **Tests/E2E:** `createFakeUpdateService({app?, state?, uploadDir?})` – `setState`, `failNext`, `setUploadIssue`,
   `setOrchestratorPid`, `setChangelog`, `setNotice`; zeichnet `commands`, `accepted`, `settingsSeen`,
   `changelogQueries`, `noticeRequests` auf; `started()`, `closed()`, `listenerCount()`.

### Ergänzung `src/server/update/README.md` (Koordinator)

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `service.ts` | `createUpdateService`: Zustand, Zeitplan, Befehle, Upload-Annahme, „Was ist neu“, Hinweise | WP-87a |
| `fetch.ts` / `latest.ts` | Abrufe mit Weiterleitungs- und Größenregeln; `latest.json` + Signatur + Changelog | WP-87a |
| `zip.ts` / `prepare.ts` | Zip prüfen und entpacken (`tar.exe`); Vorbereiten unter der Sperre `install` | WP-87a |
| `previous.ts` / `changelog.ts` / `notices.ts` / `stateFile.ts` | vorige Version; Changelog-Abschnitte; feste Textdateien; `update-state.json` | WP-87a |
| `apply.ts` | Orchestrator starten, Handschlag (Frist, Beenden bei Stille oder unlesbarer Zeile) | WP-87a |
| `routes.ts` | `POST /api/update/package`, `GET /api/changelog`, `GET /api/notices` | WP-87a |
| `testing.ts` / `testRelease.ts` | Fake-Dienst; Test-Hilfen (Release-Server, Zips) – nur für Tests | WP-87a |

## Verhalten im Detail

- **Netz:** `redirect: 'manual'`, `credentials: 'omit'`, Header nur `accept`/`cache-control`. Eine Station ohne
  `location` → `http`, zu viele oder unzulässige → `url`. Metadaten 30 s gesamt; Zip 60 s ohne Daten und 15 min
  gesamt. Größe zuerst laut `content-length`, dann gezählt. Der Download schreibt nach `…zip.partial` und rechnet
  SHA-256 beim Schreiben; `expected = maxBytes = latest.size`.
- **Prüfen:** 404 auf `latest.json` → kein Update. Fehlende/zu große `.sig` oder falsche Signatur →
  `UPDATE_INVALID_SIGNATURE {file:'latest.json'}`; Schema → `UPDATE_CHECK_FAILED {reason:'schema'}`, fremde URL →
  `url`. `prerelease` oder `-` in der Version → kein Angebot; `version ≤ laufend` → kein Angebot (`1.0.0 >
  1.0.0-rc.4`). Der Changelog-Asset muss `changelogSha256` treffen, sonst `null` → „Was ist neu“ fällt auf `notes`.
- **Vorbereiten:** Sperre (belegt → `UPDATE_BUSY {status:'locked'}`), alte Reste in `downloads` räumen, intakter
  `versions\<v>` → sofort fertig (`reused`), Download, Größe/Hash, umbenennen, listen + entpacken in
  `downloads\unpack-<v>-<zeit>-<id>`, `readSignedRelease` + Version + `minNode`, `stageVersion`, `cleanupVersions`
  (behält `current.version`, `current.previous`, laufend, neu). Zip, Teil-Datei und Entpack-Ordner werden immer
  gelöscht. Fortschritt: `downloading` 0…1, `preparing` aus unpack/check/copy/sdk zusammengesetzt.
- **Fehler:** `InstallError` signature/node/files/sdk/in_use/io wie §2.1 (in_use/io → `disk` ohne Meldungstext, damit
  keine Pfade in den Zustand gelangen), `ZipError` → `UPDATE_INVALID_PACKAGE {reason}`, `FetchError` →
  `UPDATE_DOWNLOAD_FAILED` (`url`/`aborted` → `network`, `too_large` → `size`).
- **Aus Datei:** erlaubt in idle/available/ready; dieselbe Pipeline ohne Download, Version aus dem Zip (Wurzelordner).
  Gleiche Version → `same_version` schon vor dem Entpacken; ältere → `downgrade`, `needsRestore` ohne Sicherung →
  `UPDATE_DOWNGRADE_BLOCKED` vor dem Kopieren. Bei Fehlern bleibt der vorige Zustand (inkl. Angebot) mit `error`.
- **Anwenden/Zurück:** Status/Version wie angezeigt, `acceptDataLoss` bei `needsRestore`, `release.json` des Ziels per
  Signatur (sonst `UPDATE_RESTART_FAILED {reason:'package'}` ohne Start). `rollback` liest `previous` frisch.
  Handschlag (`apply.ts`): `READY` → Pipe zu, `unref`, PID merken, `restarting`; `FAILED <r>` → `r`; Prozessende ohne
  Zeile → `handshake`; **keine gültige Zeile binnen `APPLY_TIMEOUTS.handshakeMs` oder eine unlesbare Zeile** (stdout
  des Orchestrators trägt laut 87b nur den Handschlag; Leerzeilen zählen nicht) → `killProcessTree(pid)` und erst
  danach `UPDATE_RESTART_FAILED {version, reason:'handshake'}`. Ein verspätetes `READY` trifft so keinen Server, der
  schon aufgegeben hat (87b prüft vor dem Handschlag höchstens `handshakeMs − 5 s`). Tests: `apply.test.ts`
  (Frist exakt, unlesbare Zeilen, Überlauf), `service.test.ts` (Ack und Zustand je Ausgang).
- **Zustand/Zeitplan:** ein Vorgang zugleich; automatische Prüfung überspringt laufende Vorgänge und `ready`, ihr Fehler
  landet nur in `error`. Eine manuelle Prüfung ersetzt `ready` nur durch eine neuere Version. Nach `close()` antworten
  Befehle `UPDATE_BUSY {status:'restarting'}`, Hörer werden nicht mehr benachrichtigt.
- **Was ist neu:** installiert = eigener Abschnitt bzw. alle nach `since`; angeboten (GitHub) = Abschnitte zwischen
  laufend und Ziel aus dem signierten Changelog, sonst `notes`; aus Datei = `versions\<v>\CHANGELOG.md`, bei Downgrade
  nur der Abschnitt des Ziels.

## Abweichungen und Entscheidungen

- **Eigener Body-Leser** in `fetch.ts` statt `readBodyLimited` (`sdk.ts`): der wirft einen nicht exportierten
  Fehlertyp und kennt keine Leerlauf-Frist.
- **`createUpdateService` ist async** (Marker, `update-state.json` und vorige Version werden beim Erzeugen gelesen).
- **Zusätzliche Dateien** `apply.ts`, `stateFile.ts`, `testRelease.ts` (Trennung von Handschlag, Zustandsdatei,
  Test-Hilfen).
- **`UPDATE_BUSY {status:'locked'}`** bei fremder Sperre `install` (Installer, anderer Prozess): die UI (88a) kennt
  bisher nur checking/downloading/preparing/restarting – Wunsch: Text `detail.busy.locked`.
- `assertNotRealUserFolder` in `createUpdateService` (mit Installation) und vor jeder Vorbereitung; in Tests für
  jeden Stammordner.

## Restrisiken

- Ein Zip mit falsch deklarierten Größen (Zip-Bombe) begrenzt beim Entpacken nur die Frist von 5 min; bei GitHub
  schützt der signierte Hash, bei „Aus Datei“ das Upload-Limit von 200 MiB.
- `provideSdk` ist nicht abbrechbar; `close()` wartet deshalb höchstens 10 s.
- `dismiss available` schreibt `update-state.json`; schlägt das fehl, gilt die Version nur bis zum Neustart als
  verworfen (protokolliert).

## Checks

`pnpm exec vitest run src/server/update` (15 Dateien, 99 Tests, inkl. echtem `tar.exe` auf Temp-Zips),
`pnpm exec eslint src/server/update`, `pnpm exec tsc -b` (einmal am Ende). Kein Netz, kein Live-`claude`.
