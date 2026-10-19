# Abschließendes `/code-review` Phase 2

- **Datum:** 19.10.2026
- **Umfang:** `fdc44f7..main` (Stand `3c3bb04`, 78 Commits, 440 Dateien, davon ≈ 370 Code-Dateien) –
  ganz Phase 2 (WP-30 … WP-41, R4/V3, FIX-R4, FIX-41).
- **Stufe:** high. Gründlich gelesen: Session-Engine, externe Konsole, Windows-Integration (Registry,
  Autostart, Protokoll-Handler), Uploads, Pfade, Launcher, zentrale Web-Logik. Übrige Web-UI, E2E und
  Doku nur überflogen. Keine Verstöße gegen `CLAUDE.md` gefunden.
- Die Funde sind **unverifiziert** (das Review hat nichts ausgeführt); jede Umsetzung beginnt mit einer
  Reproduktion per Test.

## Funde (nach Schwere)

| Nr. | Datei:Zeile | Befund | Szenario (Kurzform) |
|---|---|---|---|
| CR2-01 | `src/server/system/protocol.ts:55` | `registerProtocolHandler` wertet eine fehlgeschlagene Registry-Abfrage als „kein Handler“ und überschreibt einen fremden `parallax`-Handler. | `regQuery` liefert `null` bei jedem `reg.exe`-Fehler (Timeout unter Last, Exit ≠ 0, Spawn-Fehler) und bei fremden Schlüsseln ohne Standardwert in `shell\open\command` (z. B. `DelegateExecute`) → die `foreign`-Prüfung entfällt, drei `reg add /f` überschreiben `HKCU\Software\Classes\parallax` einer anderen App. Fix: „Schlüssel fehlt“ von „Abfrage fehlgeschlagen“ unterscheiden, bei Fehlschlag ablehnen. |
| CR2-02 | `src/server/sessions/external.ts:137` | `openExternal` verwirft geplantes „Weiter“ und Auto-Retry und schließt den SDK-Prozess **vor** den Schritten, die noch scheitern können (`consoleLaunchFor`, `launcher.open`). | Geplantes „nach Rate-Limit fortsetzen“; „In externer Konsole öffnen“ scheitert (AppLocker, `PROFILE_INVALID`) → `EXTERNAL_CONSOLE_FAILED`, Eintrag bleibt in Parallax, aber `continueAt`/`wakeupAt` ist weg; zur Reset-Zeit setzt nichts fort. Fix: erst Spec bauen, Plan erst bei `result.kind === 'opened'` verwerfen. |
| CR2-03 | `src/server/system/autostart.ts:185` | `createAutostartShortcut` überschreibt ein vorhandenes `Startup\Parallax.lnk` ohne Prüfung von `LAUNCHER_MARKER`, obwohl das Entfernen fremde Verknüpfungen stehen lässt (R4-11). | Eigene `Parallax.lnk` aus Phase 1 (auf `parallax.cmd` mit eigenen Flags) → Autostart an ersetzt sie still; Autostart aus löscht den Ersatz (trägt den Marker) → die Verknüpfung des Nutzers ist endgültig weg. |
| CR2-04 | `src/server/sessions/commands.ts:329` | Bei reinem Text-Prompt läuft `accept()` (geplantes Weiter verwerfen, Retry abbrechen, Prompt-Titel setzen) **vor** dem Lifecycle-Lock und der zweiten Gate-Prüfung. | Fenster A öffnet die externe Konsole, Fenster B sendet einen Prompt, der auf den Lock wartet: B hat Plan und Titel schon geändert, im Lock wirft `assertEntryGate` `SESSION_EXTERNAL`, der Prompt wird abgewiesen – Plan weg, Titel geändert. |
| CR2-05 | `src/server/sessions/manager.ts:309` | Aus `model-catalogs.json` beim Start geladene Modellkataloge und Alias-Auflösungen tragen keinen Profil-Schlüssel; `profileKeys` wird aus den aktuellen Profilen gesät. | `profiles.json` wird bei gestopptem Parallax geändert/aus `.bak` geholt (andere `.exe` oder `CLAUDE_CONFIG_DIR` = anderes Konto) → nach dem Start liefert der Cache Modelle/Aliasse des alten Kontos; `onProfileChanged` vergleicht mit Schlüsseln nach der Änderung und verwirft nie. Fix: `profileCacheKey` je persistiertem Katalog speichern, abweichende ignorieren. |
| CR2-06 | `src/server/host/fsCommands.ts:164` | Die Laufwerksliste startet 26 `stat()` gleichzeitig auf dem libuv-Pool (4 Threads); hängende Netzlaufwerke belegen den Pool und blockieren jeden anderen fs-Zugriff des Servers. | ≥ 4 getrennte Netzlaufwerke (`stat` hängt ≈ 20 s) → Ordner-Browser öffnen belegt alle 4 Threads; Transkript-Anhänge, Store-Schreiben, Blob-Lesen und die übrigen Laufwerke warten, echte Laufwerke fallen nach 1,5 s aus der Liste. Fix: Laufwerke nacheinander oder mit Parallelität 1–2 prüfen. |
| CR2-07 | `src/server/http/app.ts:282` | Der Upload speichert über den inhaltsadressierten `BlobStore`; dessen „erste Meta gewinnt“ liefert bei gleichen Bytes die **alte** Ref samt `mediaType`, Name und fehlender Breite/Höhe. | Gleiche Bytes schon vom Normalizer im Store (z. B. Tool-Ergebnis mit `application/octet-stream`) → Upload liefert die alte Ref, `resolveAttachments` weist den Prompt mit `UNSUPPORTED_MEDIA_TYPE` ab, obwohl der Server ein gültiges PNG erkannt hat; Chip mit altem Namen, ohne Pixelgröße. |
| CR2-08 | `src/web/features/composer/lib/images.ts:138` | Kleine, nicht skalierte Bilder gehen unverändert mit `type = file.type` (vom Browser, nach Endung) hoch; die Magic-Byte-Prüfung des Servers lehnt jede Abweichung mit 415 ab. | `photo.png`, das eigentlich ein JPEG ist (häufig bei heruntergeladenen/umbenannten Bildern) → Content-Type `image/png`, `sniffImageType` = `image/jpeg` → Chip scheitert mit `UNSUPPORTED_MEDIA_TYPE`. Fix: neu kodieren bzw. den erkannten Typ nehmen. |
| CR2-09 | `src/server/sessions/runtime.ts:738` | `deliverPrompt` markiert den Prozess bei `/loop` als dauerhaft geplant (kein Leerlauf-Schlaf) **vor** `agent.send()`; wirft `send`, bleibt das Flag bis zum Prozessende. | `/loop 5m check CI` während der Prozess schließt/kaputt ist → `send()` wirft, Prompt fällt aus der Queue, Befehl scheitert, `runtime.scheduled` bleibt `true` → der Prozess schläft nie (gegen ADR-105). Fix: `markScheduled` erst nach erfolgreichem `send`. |
| CR2-10 | `src/server/sessions/external.ts:315` | `importConsoleTurns` liest bei jeder Rückkehr aus der Konsole das **ganze** Transkript-Log (`readTail(…, Number.MAX_SAFE_INTEGER)`), nur für die Menge bekannter Item-IDs. | Lange Session (zehntausende Items, viele MB JSONL) → jede Rückkehr parst und hält das ganze Log im Speicher, um eine Handvoll neuer Items zu entdoppeln. Fix: nur Items ab dem Handoff bzw. ab `lastOrder` beim Handoff lesen. |

## Fix-Runde (Plan, Koordinator 19.10.2026)

- Zwei Pakete parallel, je eigener Worktree `.worktrees/cr2-sN`, Branch `fix/cr2-sN`, Basis `main`.
  Danach Merge durch den Koordinator (`--no-ff --no-commit`, `pnpm check` + `pnpm build`), dann voller
  E2E-Lauf (FakeBackend).
- Vorgehen je Fund wie in Phase 1: **erst ein Test gegen den alten Code (rot), dann der Fix (grün)**;
  die Tests bleiben als Regression. Nicht reproduzierbar oder kein Fehler → begründet zurückgestellt.
- Contracts/Ports/`src/shared/**`/`package.json`/Lockfile: tabu. Fehlercodes nur bestehende (z. B.
  `PROTOCOL_HANDLER_FAILED`, `AUTOSTART_FAILED` mit `params`).
- Kein Live-`claude`, keine Desktop-Bedienung (Nutzer-Regel 18.10.2026).

| Paket | Pfade (exklusiv in dieser Runde) | Funde | ADR-Nummern (Vorschläge) |
|---|---|---|---|
| **S1 Engine** | `src/server/sessions/**` (ohne `ports.ts`, ohne `README.md`) | CR2-02, CR2-04, CR2-05, CR2-09, CR2-10 | ADR-130 … ADR-132 |
| **S2 System/Upload** | `src/server/{system,host,http,store}/**` (ohne `ports.ts`), `src/server/lib/images.ts` (+ Test), `src/web/features/composer/**` | CR2-01, CR2-03, CR2-06, CR2-07, CR2-08 | ADR-133 … ADR-135 |

Ergebnis je Paket in `docs/wp/CODE-REVIEW-2-S1.md` bzw. `CODE-REVIEW-2-S2.md` (Tabelle je Fund:
reproduziert, Fix, Regressionstest, Commit). ADR-Texte und README-Änderungen schreiben die Pakete als
Vorschlag in ihr Ergebnis; `docs/decisions.md` und die Ordner-READMEs mit mehreren Ownern pflegt der
Koordinator beim Merge.

## Umsetzung

(folgt nach dem Merge)
