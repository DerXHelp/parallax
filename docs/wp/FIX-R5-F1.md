# FIX-R5-F1 – Fix-Paket F1 Server (Ergebnis)

> Auftrag: `docs/wp/FIX-R5.md` §2, Zeile **F1 Server** (Pfade `src/server/**` ohne `**/ports.ts` und
> `backend/{types,fixture}.ts`). Basis `feature/phase-3` = `87def00`, Branch `fix/r5-f1` (Worktree
> `.worktrees/fix-r5-f1`). Normativ: ADR-152. Befunde: `docs/wp/R5.md` (R5-01, R5-02, R5-04, Probe P1),
> `docs/wp/V4.md` (V4-02, V4-05). Kein Live-`claude`, kein SdkBackend-Test, kein Programmstart, keine
> Registry-Schreibzugriffe.

## 1. Befunde

| Befund | Stand | Fix (Fundstellen) | Test (Gegenprobe ohne Fix rot) |
|---|---|---|---|
| **R5-01** (SOLLTE, ADR-152) | behoben | **Normalizer:** `classifyUserText(text, source)` (`sessions/normalizer/builders.ts`) mit `UserTextSource {originKind, parentToolUseId}`; `taskNotificationOf` wertet `<task-notification>` nur beim Hauptagenten und mit `origin.kind === 'task-notification'` (`TASK_NOTIFICATION_ORIGIN`). Andere Herkunft (human, channel, peer …) → normaler Prompt; Subagent (`parentToolUseId` gesetzt) → kein Task, der Aufrufer verwirft den Prompt wie bisher; **ohne `origin`** (ältere Transkripte) → Meldung wird angezeigt (auch Status/Zusammenfassung des genannten Tool-Calls), `outputFile` aber immer `null`. Aufrufer `history.ts` (`HistoryMessage.origin`) und `live.ts` (`u.origin`) geben Herkunft und `parent` mit – die Prüfung liegt damit **vor** der bisherigen `parent`-Weiche. Test-Harness `normalizer/testing/harness.ts` `toHistoryMessages` übernimmt `origin` jetzt wie `backend/history/parse.ts` (sonst hätten die Fixture-Tests nie eine Herkunft gesehen). **Index (Tiefenverteidigung):** `files/sessionIndex.ts` `isTaskOutputFile(file, taskId)`: ein `output`-Eintrag nur für die Form der CLI-Task-Daten `…\tasks\<taskId>.output` (letzter Ordner `tasks`, Dateiname = Task-ID + `.output`, case-insensitiv; eine Task-ID mit Trennern passt nie) – für `task_notification`-Items und `tool_call.task.outputFile`; greift auch für Transkripte, die vor ADR-152 geschrieben wurden (Backfill) | **Negativ (P1):** `history.test.ts` und `live.test.ts` „a `<task-notification>` text without the CLI origin …“ – P1-Text mit Pfad außerhalb (`…\r5-p1\outside\secret.txt`) für `origin` human / channel / null / fehlend × `parentToolUseId` null / gesetzt (auch mit `origin` task-notification beim Subagenten) und mit `<tool-use-id>` eines echten Agent-Aufrufs: nie ein `outputFile`, der Agent-Call bleibt unberührt, der Nutzertext bleibt Prompt (auch ein registrierter Prompt dieses Clients); „an older transcript (no origin) still finishes the Agent call …“. `sessionIndex.test.ts`: fünf Pfadformen ohne Eintrag (P1, andere Task-ID, andere Endung, Unterordner, Projektdatei gleichen Namens), `isTaskOutputFile` mit echtem CLI-Pfad aus `subagent.jsonl`, Fake-Pfad, Großschreibung, `..`; „a transcript written before ADR-152 … adds nothing“ (Backfill: `keys` ohne den gefälschten Pfad). **Positiv (echte Fixtures):** `history.test.ts` „normalizeHistory: subagent“ – Verlauf aus `history.jsonl` (`origin.kind: 'task-notification'`, CLI 2.1.322) liefert dasselbe `outputFile` wie live (`system/task_notification.output_file`), Snapshot unverändert; WP-52-Test jetzt mit CLI-Herkunft. **Gegenprobe:** Normalizer-Quellen per `git stash` zurück → 3 Tests rot; Index-Prüfung neutralisiert → 6 Tests rot |
| **V4-02** (SOLLTE) | behoben | `backend/fake/interactive.test.ts` `until()`: Wanduhr-Limit `UNTIL_TIMEOUT_MS` = 10 s (`performance.now()`, unter dem 20-s-Test-Timeout des `node`-Projekts, damit ein ausbleibendes Ereignis weiter mit „timeout waiting for …“ scheitert) statt 20 000 `setImmediate`-Runden (Muster FLAKES.md „Wanduhr-Annahme“) | `until (test helper, V4-02)`: ein 1,5-s-Timer (langsame I/O) kommt an; das Limit greift nach seiner Wanduhrzeit mit Grund. **Gegenprobe:** alte Rundenschleife → beide rot („timeout waiting for the slow timer“ nach ≪ 1,5 s). Lastlauf siehe §3 |
| R5-02 (NIT) | behoben | `files/open.ts`: Arbeitsordner des Editors = Ordner der Editor-`.exe` (`path.win32.dirname(executable)`) statt Ordner der Datei; die Datei geht weiter absolut als Argument | `open.test.ts` (Preset Notepad++ → `C:\Program Files\Notepad++`, `custom` → `D:\Tools`); Gegenprobe rot |
| R5-04 (NIT) | behoben | `files/editors.ts`: `editorCandidates` als Async-Generator in Suchreihenfolge, `findEditor` prüft jeden Kandidaten sofort → nach dem ersten Treffer kein weiteres `reg.exe` (Reihenfolge und Ergebnis wie bisher). `createEditorFinder({ttlMs, now})` (`EDITOR_CACHE_MS` = 60 s): Treffer je Preset gemerkt, vor Gebrauch per Stat erneut geprüft (deinstalliert → neue Suche), Fehlschläge nie gemerkt (frische Installation sofort gefunden); `refresh` sucht immer neu. `resolveEditorExecutable`/`detectEditors` nehmen optional die Suchfunktion; `createSystemLauncher` nutzt `find` für Klicks und `refresh` für `editor.detect` (Einstellungen) – Option `now` | `editors.test.ts`: Treffer in HKLM-32 → genau 3 Abfragen; Treffer in HKCU → 1 Abfrage, 1 Stat; Finder (TTL, verschwundene `.exe`, `refresh`, Fehlschlag ungemerkt, eigene Einträge je Preset). `open.test.ts` „editor lookup (R5-04)“: zweiter Klick ohne Registry, nach 60 s neu, `detect` neu, deinstalliert → `EDITOR_NOT_FOUND`. Gegenprobe rot (8 Tests) |
| V4-05 (a) (NIT) | behoben | `FAKE_CLAUDE_VERSION` = `2.1.322` (nach `backend/fake/defaults.ts` verschoben; `integration.ts` importiert) – Install-Status, Launch-Spec **und** `init.claude_code_version` der Fake-Sessions (`dsl.ts` `initFrame`; daraus kommt die Anzeige „CLI …“ im Session-Kopf, vorher fest `2.1.300` aus `synthetic/build.ts`) | `integration.test.ts`: Konstante = `claudeCodeVersion` des installierten SDK (`readSdkManifest`), Status `ok` – ein SDK-Upgrade macht den Test rot (`docs/sdk-upgrade.md`) |
| V4-05 (b) (NIT) | behoben | Fake-Stichwort **`fake:context-high`** (`phase3.ts` `contextHigh`, Dispatch `interactive.ts`): `FakeScriptState.contextTokens` = `FAKE_CONTEXT_HIGH_TOKENS` (150 000 von 200 000 = 75 %); `fakeContextUsage(turns, model, contextTokens)` antwortet damit fest; `DslContext.contextTokens` setzt die `usage` von `message_start`/`message_delta` jeder gestreamten Nachricht auf genau diesen Wert (Schätzung während späterer Turns, z. B. der Plan-Entscheidung; `synthetic/build.ts` `messageStart` mit optionaler `usage`). Zurück auf Normal nach `/clear` und `fake:compact`/`/compact`; ein neuer Prozess (frischer Kontext, Resume) beginnt normal | `interactive.test.ts` „fake:context-high …“: `getContextUsage` 75 %, Schätzung 150 000, bleibt über einen Werkzeug-Turn, fällt nach Kompaktierung und `/clear` unter 60 %. `phase3.integration.test.ts` „fake:context-high (V4-05) …“ (Engine mit echtem Normalizer): Gauge 75 % (`sdk`, `maxTokens` 200 000), während der folgenden `fake:plan`-Entscheidung weiter 75 %, nach „Mit frischem Kontext“ unter 60 %. Ohne Szenario wäre das Stichwort ein Echo (< 60 %) |

## 2. Entscheidungen

1. **Ohne `origin` anzeigen, aber ohne `outputFile`** (ADR-152, „ältere Transkripte“) – gilt einheitlich
   für Verlauf **und** live (CLI 2.1.322 setzt `origin` immer). Eine solche Meldung aktualisiert weiter
   Status/Zusammenfassung des genannten Tool-Calls, damit alte Verläufe fertige Hintergrund-Agenten nicht
   als „unterbrochen“ zeigen; der Missbrauch dieser Lücke setzt einen Verlauf einer CLI ohne `origin`
   voraus und öffnet keine Datei.
2. **Tiefenverteidigung im Index über die Pfadform** `…\tasks\<taskId>.output` statt einer Herkunftsmarke:
   `TaskInfo` hat kein Herkunftsfeld (Contract eingefroren), die Form gilt für Agent- und Bash-Tasks der
   CLI und für den Fake. Kein `%TEMP%\claude\`-Präfix verlangt (der Fake schreibt unter
   `<home>\fake-files`, `CLAUDE_CODE_TMPDIR` kann das CLI-Ziel verschieben).
3. **Editor-Cache nur für Treffer** (60 s, Stat vor Gebrauch), `editor.detect` sucht immer neu und
   ersetzt den Treffer – „bis zur nächsten Editor-Einstellung“ ohne neue Kopplung an den Settings-Store.

## 3. Checks

| Schritt | Ergebnis |
|---|---|
| `pnpm exec tsc -b` | grün |
| `pnpm exec eslint <geänderte .ts> --max-warnings=0` | grün |
| `pnpm exec vitest run src/server` | grün, 129 Dateien / 2801 Tests (17 s) |
| Lastlauf V4-02 | grün: 4× `interactive.test.ts` + `phase3.integration.test.ts` gleichzeitig mit einem vollen `vitest run src/server` (dazu die parallelen Pakete F2–F5 auf demselben Rechner) – 4 × 60/60, 2801/2801 |
| `pnpm check` | grün: `tsc -b` ✓, ESLint ✓, Vitest 278 Dateien / **4776/4776** (43 s); keine Last-Flakes in fremden Dateien beobachtet |
| `pnpm build` | grün (`0.0.0+87def0000bdc.dirty-…`, vor dem Commit) |

Gegenproben (Fix-Dateien per `git stash` bzw. vorübergehender Änderung zurückgesetzt, Tests
unverändert): R5-01 Normalizer 3 rot, R5-01 Index 6 rot, V4-02 2 rot, R5-02/R5-04 8 rot.

## 4. Zurückgestellt

- Keiner der Befunde dieser Zeile. Bewusst nicht umgesetzt: R5-Vorschlag (2) „`output` nur unter
  `%TEMP%\claude\…\tasks\`“ in der strengen Form mit Präfix (Grund: Entscheidung 2).

## 5. Live-Prüfpunkte für WP-61

1. **Echte Task-Meldungen (ADR-152):** Hintergrund-Agent und Hintergrund-Bash starten; live und nach
   Neustart im Verlauf prüfen, dass `outputFile` gesetzt ist und der Viewer die Ausgabe öffnet
   (CLI liefert `origin.kind: 'task-notification'`, Datei `…\tasks\<taskId>.output` – beides Annahmen
   aus den Fixtures). Gegenprobe: einen kopierten `<task-notification>`-Block als Prompt senden → er
   erscheint als Nutzer-Nachricht, kein Ausgabe-Link, die Datei ist nicht per `file.stat` erreichbar.
2. **`remote_launched`/MCP-Tasks:** falls vorhanden, prüfen, ob deren `outputFile` ebenfalls die Form
   `…\tasks\<taskId>.output` hat (sonst kein Ausgabe-Link – dann Regel erweitern).
3. **Editor (R5-02/R5-04):** Notepad++/VS Code öffnen – im Prozess-Explorer Arbeitsordner = Programmordner;
   zweiter Klick innerhalb einer Minute ohne `reg.exe`-Prozesse; Editor deinstallieren/umbenennen →
   nächster Klick sucht neu.
4. **Fake:** Session-Kopf zeigt „CLI 2.1.322“ ohne Warnung; `fake:context-high` dann `fake:plan` →
   „Empfohlen“ am ▾ (F6-E2E).

## 6. Wünsche an den Koordinator / Folgen für andere Pakete

- **F6 / E2E (nicht im F1-Besitz):** `e2e/phase2-new-session.spec.ts:109` erwartet beim Profiltest
  `2.1.300` – nach dem Merge `2.1.322` (bzw. die Konstante). Sonst wird `pnpm e2e` rot. Neuer Fall
  „Empfohlen“ mit `fake:context-high` (Stichwort steht in `backend/fake/README.md`); `e2e/README.md`
  listet die Stichwörter (Koordinator/F6).
- **Hinweis (kein Wunsch):** `SDKMessageOrigin` kennt bei `kind: 'task-notification'` auch `subkind`
  (`peer-send-message` = von einem Modell einer anderen Session geschriebener Text, `scheduled-trigger`
  …). Die CLI-eigenen Hintergrund-Meldungen haben kein `subkind`. Strenger wäre „ohne `subkind`“; dafür
  müsste `HistoryMessage.origin` (Contract `backend/types.ts`, eingefroren) das Feld mitführen. Für
  Parallax derzeit ohne Bedeutung (keine Cross-Session-Nachrichten) – bei Bedarf als Contract-Änderung.
