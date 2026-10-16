# Abschließendes `/code-review` Phase 1

- **Datum:** 16.10.2026
- **Umfang:** `323a52f..main` (Stand `5bb2d9b`, 179 Dateien) – alle Änderungen nach R3 (R3-/V2-Fixes, WP-22, WP-22-Fixes, Doku).
- **Stufe:** high. Die Funde sind **unverifiziert** (das Review hat nichts ausgeführt); jede Umsetzung beginnt mit einer Reproduktion per Test.
- **Zusätzlich** (Doku-Nachzug `1f9a78e`): `serverArgsFor` (`src/server/launcher/args.ts`) reicht `--toasts` nicht an den Server weiter; `lib/toast.ts` fehlt in den Ownership-Tabellen.

## Funde (nach Schwere)

| Nr. | Datei:Zeile | Befund | Szenario (Kurzform) |
|---|---|---|---|
| CR-01 | `src/server/sessions/recovery.ts:150` | `checkRecord` beendet Snapshot-Kinder per PID mit Prozessinfos von **vor** dem `taskkill /T` der Wurzel. | Wiederverwendete PID → fremder Prozessbaum wird hart beendet (genau das sollte R2-03 verhindern); bis zu 200 unnötige `taskkill`-Starts je Record. Fix: Kinder nach erfolgreichem Wurzel-Kill überspringen bzw. direkt vor jedem Kill `isProcessAlive` + Startzeit erneut prüfen. |
| CR-02 | `src/server/sessions/manager.ts:623` | Shutdown beendet jeden `claude.exe`-Baum hart, dessen `agent.close()` nach 2,5 s nicht fertig ist (vorher 15 s). | SessionEnd-Hooks/JSONL-Schreiben dauern 3–4 s → abgeschnitten, Transkript/Sidecar-Dateien können unvollständig sein, `--resume` verliert den letzten Turn. |
| CR-03 | `src/server/sessions/nativeToasts.ts:55` | `toastText` nutzt den Titel als Ersetzungsstring in `String.prototype.replace` (`$&`, `` $` ``, `$'`, `$$`). | Titel „Fix $& escaping“ ergibt falschen Toast-Text. Fix: Ersetzungsfunktion oder `split`/`join`. |
| CR-04 | `src/server/launcher/launcher.ts:586` | Build-Lock `acquireDirectoryLock('build', repoRoot)` wirft `TypeError` für Pfade, die `windowsPathIssue` ablehnt (UNC, Punkt am Ende …). | Checkout auf `\\nas\…` mit veraltetem `dist/` → generischer Absturz statt Build (Regression seit R3-04). |
| CR-05 | `src/server/sessions/nativeToasts.ts:102` | Ein einziges fehlgeschlagenes Toast-Ergebnis (auch Timeout unter Last, fehlgeschlagenes `History.Remove`) schaltet native Toasts für den ganzen Serverlauf ab. | Kurzzeitig hohe Last → keine fensterlosen Benachrichtigungen mehr bis zum Neustart. Abschalten nur bei deterministischen Fehlern (CLM/AppLocker). |
| CR-06 | `src/server/sessions/manager.ts:598` | Der Shutdown-Interrupt bei offenen Entscheidungen kann die CLI den nächsten bereits gequeueten Prompt starten lassen, bevor `close()` ankommt. | Modellaufruf (Tokens), Tools, neue Permission-Requests im eingefrorenen Broker, danach Kill → inkonsistentes Transkript/Queue nach Neustart. |
| CR-07 | `src/shared/http.ts:201` | `pageCsp` wirft über `checkedPort` einen `RangeError` für Port 0; `app.ts` fällt vor `listen` auf `config.port` (0) zurück. | `PARALLAX_PORT=0`/Testserver: HTML-Antwort per `inject` oder vor aufgelöster Adresse → 500 statt Seite. |
| CR-08 | `e2e/global-setup.ts:18` | Design: Der Build-Lock (R3-04) existiert nur im Launcher; `pnpm build` und das E2E-Setup nehmen ihn nicht. | Gleichzeitiges `pnpm e2e` und Launcher-Build auf demselben Checkout leeren/schreiben `dist` gleichzeitig. Fix: Lock in `runBuild`/`build.ts` für alle Aufrufer. |
| CR-09 | `test/setup/home.ts:37` | Regelverstoß `CLAUDE.md` („Pfadregeln nur aus `@shared/paths` … Nie duplizieren.“): eigene `pathKey`/`isPathInside`. | Abweichende Normalisierung (Laufwerkswurzel, doppelte Trenner) → Test-Schutz und `config.ts` urteilen unterschiedlich über das echte Home. |
| CR-10 | `src/server/main.ts:96` | Während des Starts sieht der Crash-Handler `shutdown === null` (`running` erst nach `startServer`), beendet per `process.exit(1)` ohne Aufräumen. | Unbehandelte Rejection nach Schritt 5/6 (listen, Lockfile geschrieben) → veraltetes `server.lock.json`, ungeschriebene Store-Daten. |
| CR-11 | `src/server/launcher/args.ts` | `serverArgsFor` reicht `--toasts` nicht weiter (aus Doku-Nachzug). | `parallax.cmd --toasts=off` wirkungslos, nur `PARALLAX_TOASTS=off` wirkt. |
| CR-12 | `CLAUDE.md`, `src/server/lib/README.md` | `lib/toast.ts` fehlt in den Ownership-Tabellen. | Doku-Lücke. |

## Umsetzung
Fix-Runde 16.10.2026, Branch `fix/final` (Stand main `5bb2d9b`), einziger aktiver Agent. Vorgehen je
Fund: erst ein Test gegen den alten Code (rot), dann der Fix (grün); die Tests bleiben als Regression.
ADR-090 … ADR-093 (`docs/decisions.md`).

| Nr. | Reproduziert | Fix | Test (Regression) | Commit |
|---|---|---|---|---|
| CR-01 | ja (7 Tests rot) | Nach erfolgreichem Wurzel-`taskkill /T` endet der Record; sonst jeder Kill erst nach frischer Prüfung genau dieser PID (tot → übersprungen, nach einem Kill neue gebündelte Abfrage); `unknown` beendet nichts mehr (ADR-093) | `recovery.test.ts` „CR-01: …“ (Wurzel lebt, PID nach Kill wiederverwendet, Kind schon tot, frische Prüfung `unknown`, spätere Wurzel wiederverwendet); Engine-Test WP22-06 angepasst | `233917c` |
| CR-02 | ja (2 Tests rot) | `shutdownKillAfterMs` 5 s **je Session ab ihrem `close()`**, dann `taskkill`; Sweep des Rahmens erst nach 8 s (`SHUTDOWN_SWEEP_GRACE_MS`) (ADR-090) | Engine „CR-02: a close() that needs 4 s … is not cut off“, „killed after shutdownKillAfterMs“ (5 s statt 2,5 s) | `233917c` |
| CR-03 | ja | `replace('{title}', () => title)` | `nativeToasts.test.ts` „CR-03“ | `ed350d5` |
| CR-04 | ja (`TypeError: build lock: unsafe path (unc)`) | `acquireBuildLock`/`buildLockKey` in `launcher/build.ts` über `acquireKeyLock` (ohne Pfadprüfung/Dateizugriff für UNC; Laufwerkspfade wie bisher per realpath) (ADR-092) | `launcher.test.ts` „CR-04: … UNC share is no TypeError“ (echte Pipe), `build.test.ts` „CR-04“ | `ed350d5` |
| CR-05 | ja (Kanal nach einem Timeout aus) | `failed.permanent` in `lib/toast.ts` (Sprachmodus-Prüfung, Exit 4 = Einrichtung, Exit 3 = Aktion); nur dauerhaft schaltet ab, sonst zählen, ab drei in Folge Pause 1 min … 15 min (ADR-091) | `nativeToasts.test.ts` „CR-05“ (Timeout, `History.Remove`, Backoff), `toast.test.ts` (Klassifikation, Skript) | `ed350d5` |
| CR-06 | ja (Engine-Tests rot; **live** zusätzlich: auch `close()` allein lässt eine wartende CLI weiterarbeiten) | Wartend ohne Queue/Hintergrund-Task: `interrupt` (≤ 1 s) + `close()`; wartend **mit** Queue oder Hintergrund-Task: weder Interrupt noch `close()`, sofort `taskkill`, danach `PROMPT_NOT_DELIVERED` (ADR-090) | Engine „CR-06: … queued prompt …“, „CR-06: … background work …“ (kein Interrupt, kein `close()`, Kill, Prompt nie gestartet, nach Neustart `expired`) | `233917c` |
| CR-07 | ja (500) | `app.ts`: Port unbekannt (0 vor `listen`) → Guard `HOST_HEADER_REJECTED`, CSP `BLOB_CSP`; kein Contract-Eingriff | `app.test.ts` „CR-07“ | `ed350d5` |
| CR-08 | ja (Design; E2E-Setup ohne Lock) | Lock in `launcher/build.ts` (`acquireBuildLock`, `pollLock`); E2E-Setup prüft und baut darunter, `scripts/build-server.ts` nimmt ihn (außer `runBuild` hält ihn, `PARALLAX_BUILD_LOCK_HELD=1`) (ADR-092). **Offen:** Vite-Schritt von `pnpm build` braucht `package.json`-Änderung | `build.test.ts` (Marker, `pollLock`, Skript nimmt den Lock); manuell: `pnpm build:server` wartete auf einen gehaltenen Lock | `ed350d5` |
| CR-09 | Regelverstoß ja, Verhaltensabweichung nein (Tests alt und neu grün) | `test/setup/home.ts` nutzt `windowsPathKey`/`isWindowsPathInside` aus `@shared/paths` | `env.test.ts` „CR-09: the test guard judges … like config.ts“, Laufwerkswurzel/doppelte Trenner | `ed350d5` |
| CR-10 | ja (2 Tests rot) | `startServer` meldet den Shutdown-Rahmen per `onShutdownFrame` (vor `listen`), `main.ts` gibt ihn dem Crash-Handler; ein Fehlerpfad während eines laufenden Shutdowns wartet auf ihn statt doppelt aufzuräumen | `compose.test.ts` „CR-10: …“ (Fehler nach `listen` → geordnet, Lockfile weg; kein zweites Aufräumen) | `233917c` |
| CR-11 | ja | `serverArgsFor` reicht `--toasts=` weiter; Usage nennt `--toasts` | `args.test.ts` „CR-11“ | `ed350d5` |
| CR-12 | ja (`CLAUDE.md`; `lib/README.md` hatte die Zeile schon) | Zeile `src/server/lib/toast.ts` in `CLAUDE.md` (150 Zeilen) und `architecture.md` §2.1; `lib/README.md` aktualisiert (CR-05) | – | Doku-Commit „Code-Review-Fixes: …“ |

**Live-Messung (CR-02/CR-06, einmal):** Abo-Login (`claude.ai`, `apiKeySource: none`), `claude`
2.1.300, Haiku, Temp-Home, drei Sessions: A wartet auf eine Write-Karte (Queue leer), C wartet mit
einem gequeueten Prompt, B arbeitet (`ping -n 60`). `server.shutdown` → WS-Close 4503 nach 6,6 s,
Prozessende 6,75 s (`totalMs 6597`): A per Interrupt nach 1,1 s sauber beendet („[Request
interrupted by user for tool use]“, kein Modellaufruf); B 5,0 s nach `close()` per `taskkill`
(Backend und Engine gleichzeitig, Ende nach 6,55 s). **C (damals noch `close()` ohne Interrupt):**
die CLI meldete „Tool permission request failed: AbortError: Tool permission stream closed“, rief
das Modell erneut auf und beantwortete den gefalteten Queue-Prompt, Exit 0 nach 2,5 s – deshalb
beendet die Engine eine wartende Session mit Queue jetzt sofort (Engine-Tests; keine zweite
Live-Messung). Keine Prozesse übrig. Kosten: kein Turn mit `result` (nicht über `turn_result`
erfassbar); 5 API-Aufrufe, ≈ 60 k Cache-Write-, 93 k Cache-Read-, 0,7 k Output-Tokens – nach den
Segmentkosten aus WP-22 geschätzt ≈ 0,02–0,03 USD (Budget 0,20 USD). CLI-Transkripte
unter `~/.claude/projects/C--Users-<USER>-AppData-Local-Temp-parallax-live-e2e-Mre6TK-0{1-a,2-c,3-b}`
(nicht gelöscht).
