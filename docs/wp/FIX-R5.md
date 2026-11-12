# FIX-R5 – Fix-Runde nach R5, R5-web und V4 (Phase 3)

> Koordinator, 12.11.2026. Grundlage: `docs/wp/R5.md` (Server, 0/1/3), `docs/wp/R5-web.md` (Web,
> 0/4/7), `docs/wp/V4.md` (Verifier, 0/3/4) und die bekannten Follow-ups der Phase-3-Tabelle in
> `docs/progress.md`. Kein BLOCKER. Entscheidungen: ADR-152 (Task-Meldungen nur mit Herkunft),
> ADR-153 (`de`-Wörterbücher lazy). Integrations-Branch `feature/phase-3`.

## 0. Koordinator-Paket K (auf `feature/phase-3`, vor Welle Fa)

- **R5-03** (Contract-Änderung, freigegeben): `EDITOR_BLOCKED_EXECUTABLES` in `src/shared/model.ts`
  um `hh.exe`, `msiexec.exe`, `mmc.exe`, `regedit.exe`, `control.exe`, `msdt.exe`,
  `powershell_ise.exe` ergänzt (Test in `model.test.ts`). Phase 3 ist noch nicht auf `main`, also
  gibt es keine gespeicherten Editor-Einstellungen der produktiven Instanz, die dadurch ungültig würden.
- **R5W-09/V4-06 (a), Basis:** neu `src/web/lib/bytes.ts` `formatFileSize(bytes, format)` –
  **eine** Größenanzeige, dezimal wie die Limits (unter 1000 ganze Bytes mit langer Einheit, kB ganz,
  MB/GB mit einer Nachkommastelle; `10 000 000 B` = „10 MB“ in Chip und Viewer). F3 und F4 stellen
  darauf um und löschen ihre eigenen Formatierer.
- ADR-152, ADR-153, dieses Dokument, Contract-Changelog, `lib/README`.

## 1. Ablauf

- **Welle Fa** (parallel, je eigener Worktree `.worktrees/fix-r5-fN`, Branch `fix/r5-fN`, Basis
  `feature/phase-3` nach K): **F1 Server**, **F2 Transkript/Tasks**, **F3 Composer**,
  **F4 Dateien/Plan**, **F5 Shell/i18n/App**. Danach Merge (Koordinator, `--no-ff --no-commit`,
  `pnpm check` + `pnpm build`).
- **Welle Fb:** **F6 E2E/Bundle** auf dem gemergten Stand (neue E2E-Fälle, Bundle-Messung, voller
  E2E-Lauf 2×, davon 1× unter Last).
- Jeder SOLLTE-Befund wird behoben **mit Test** (Gegenprobe: ohne Fix rot, wo sinnvoll) oder
  begründet zurückgestellt (im Ergebnis unter „Zurückgestellt“ mit Grund). NITs sind erwünscht, aber
  nachrangig; was ein Paket nicht schafft, steht unter „Zurückgestellt“.
- Nur die Pfade des eigenen Pakets ändern (Tabelle §2). Contracts/Ports (`src/shared/**`,
  `**/ports.ts`, `backend/{types,fixture}.ts`), `package.json`, Lockfile, `playwright.config.ts`:
  tabu (Wunsch → Bericht). Features importieren einander nie; Features dürfen Shell-Bausteine und
  `src/web/lib` importieren.
- Kein Live-`claude`. Keine Desktop-Bedienung per Skript. Lange Läufe im Hintergrund mit Ausgabe in
  Dateien. Gestartete Prozesse am Ende beenden.
- Ergebnis je Paket in einer eigenen Datei `docs/wp/FIX-R5-FN.md` (dieses Dokument bleibt
  unverändert).

## 2. Pakete

| Paket | Pfade (exklusiv in dieser Runde) | Befunde |
|---|---|---|
| **F1 Server** | `src/server/**` ohne `**/ports.ts` und `backend/{types,fixture}.ts` | **R5-01** (SOLLTE, ADR-152: Normalizer `builders.ts`/`history.ts`/`live.ts` werten Task-Meldungen nur mit `origin.kind === 'task-notification'` beim Hauptagenten; ohne `origin` kein `outputFile`; Index `files/sessionIndex.ts` `output` nur aus CLI-Task-Daten; Tests mit der Probe P1 aus R5 als Negativfall und echten Fixtures als Positivfall), **V4-02** (SOLLTE, `backend/fake/interactive.test.ts` `until()` mit Wanduhr-Limit statt Runden, Muster `docs/wp/FLAKES.md`), R5-02 (Editor-Arbeitsordner = Ordner der Editor-`.exe`), R5-04 (Editor-Suche: beim ersten Treffer aufhören, Ergebnis je Preset kurz cachen), V4-05 (a) `FAKE_CLAUDE_VERSION` auf die SDK-Erwartung 2.1.322, (b) Fake-Szenario `fake:context-high` (Context dauerhaft ≈ 75 %, für die Hervorhebung „Empfohlen“ und F6) |
| **F2 Transkript/Tasks** | `src/web/features/{transcript,tasks}/**`, `src/web/lib/file-refs.ts` (+ Test) | **V4-01** (SOLLTE: absolute Pfade mit Leerzeichen – ein Inline-Code-Span ist ein Kandidat als Ganzes; Laufwerkspfade im Fließtext bis zur letzten plausiblen Dateiendung erkennen, ggf. per Stat auf den längsten existierenden Präfix kürzen; ein bloßes Präfix-Stück nie als `refused` markieren), **R5W-04 (3)** (`TaskStrip.test.tsx:114` Testlimit ≥ `find`-Timeout), Flake `transcript/renderers.test.tsx` (jsdiff-Fallback: auf den Lazy-Chunk warten), **R5W-01** Anteil (`todoProgress` in ein eigenes kleines Modul, `tasks/lib/rows.ts` nur im Panel-Chunk), R5W-05 (`EMAIL_PATTERN` ohne quadratisches Backtracking + Zeitgrenzen-Test), R5W-06 Anteil (`.join(' · ')` in `TasksPanel`/`TaskStrip` → Schlüssel mit Platzhaltern), R5W-07 (Fokus nach „Alle stoppen“ zurück), R5W-11 Anteil (feste Wartezeiten in `TranscriptView.test.tsx`, Bash-Stop-Flag am Panel, Strip-Zustand mit zwei Sessions), V4-07 Anteil optional (lange Nutzer-Nachricht einklappbar) |
| **F3 Composer** | `src/web/features/composer/**` | **R5W-03** (SOLLTE: Paste-Chip am Feldanfang darf nie als Slash-Befehl ankommen – beginnt der Feldtext selbst nicht mit `/`, wird das führende `/` des expandierten Texts neutralisiert; Test „Paste `/clear …` am Anfang → kein nativer Befehl, Prompt beginnt nicht mit `/`“), **V4-03** (SOLLTE: `@`-Picker setzt den aktiven Eintrag bei jeder Änderung des Suchtexts auf 0; Fuzzy-Mindestgüte bzw. Vorrang für Treffer im Dateinamen und zusammenhängende Teilstrings, keine Streutreffer über tiefe Ordnernamen), **R5W-01** Anteil (`FileMentionMenu`, `PasteChips` per `React.lazy`, `lib/folders.ts` per `import()` im Drop-/Paste-Pfad), V4-07 (Zeilenumbruch nach einem Paste, der nicht mit einem endet), R5W-09 Anteil (`@web/lib/bytes` statt `lib/format.ts`), R5W-11 Anteil (`drafts.ts`: werfender Storage, kaputtes JSON) |
| **F4 Dateien/Plan** | `src/web/features/{files,decisions}/**`, `src/web/ui/{code-block,diff-view,copy-button}.tsx`, `src/web/index.css` (nur Syntax-/Link-Tokens) | **R5W-04 (1)(2)** (SOLLTE: `DecisionBar.test.tsx:245` wartet auf den Lazy-Inhalt; `FilePanel.test.tsx` mit Datei-`testTimeout` bzw. Warten auf Lazy-Chunks – V4: unter Last 3/3 rot, Fälle PDF, image, cut text), V4-04 (eigenes Token `--syntax-keyword` mit Dark-Wert in `index.css`, `ui/code-block.tsx` nutzt es; Inline-Code-`FileLink` im hellen Theme ≥ 4,5:1), V4-06 (a) `@web/lib/bytes` statt `files/lib/format.ts`, (b) lange Pfade in Panel und Viewer-Kopf in der Mitte bzw. vom Anfang kürzen (Dateiname bleibt sichtbar), (c) gelöschte Datei: veralteten Inhalt kennzeichnen bzw. Metadaten ausblenden), R5W-06 Anteil (`FileLink`-Tooltip als Schlüssel mit Platzhaltern), R5W-09 Anteil (`isLocalSession` aus `@web/shell/navigation/session-actions` statt eigener Kopie), R5W-10 Anteil (Stat-Cache bündelt Benachrichtigungen; `file-document` setzt nur bei Änderung; `CodeView` nutzt `col` oder das Ziel verliert es), R5W-11 Anteil (`bar-store` mit werfendem Storage, `FileLink.test.tsx` mit Fake-Timern) |
| **F5 Shell/i18n/App** | `src/web/shell/**`, `src/web/state/**`, `src/web/i18n/**`, `src/web/features/preferences/**`, `src/web/lib/**` (ohne `file-refs.ts`, `bytes.ts`), `src/web/{App,main}.tsx`, `src/web/App*.test.tsx`, `src/web/playground/**` | **R5W-01** (SOLLTE, ADR-153: `de`-Wörterbücher als ein Lazy-Chunk, `setLanguage('de')` lädt vor dem Umschalten, optional Vorladen nach der zuletzt genutzten Sprache, Fehler → Englisch + einmaliger Hinweis; `i18n.test.tsx` anpassen; Start-Chunk vorher/nachher messen), **R5W-02** (SOLLTE: `SlotBoundary` mit optionalem `fallback`; `App.tsx` gibt `FileLink` als Fallback den Pfad als Text bzw. `PlainReference`; ein Chunk-Fehler höchstens einmal je Fenster laut; Test „20 Verweise, Chunk-Fehler → Text, ≤ 1 `role="alert"`“), R5W-06 Anteil (`'99+'` in `header-panels.tsx`, `DEFAULT_PROGRAM_EXTENSIONS.join(', ')` in `preferences` über `Intl.ListFormat`/Schlüssel), R5W-10 Anteil (`openFolderInExplorer` mit clientseitigem `windowsPathIssue`-Filter), R5W-11 Anteil (`SidePanelHost.test.tsx:301` drückt wirklich Tab; `open-folder.test.tsx` mit `PATH_NOT_ALLOWED`; Polling nur bei sichtbarem Tab direkt testen), optional `shellPhase3Demos` direkt in `playground/demos.tsx` registrieren |
| **F6 E2E/Bundle** (nach Fa) | `e2e/**` (ohne Live-Lauf), `scripts/**` (nur ein Budget-Skript, optional) | Neue Fälle: V4-01 (Projektordner mit Leerzeichen/Umlaut, absoluter Pfad im Text und in Backticks wird verlinkt und öffnet den Viewer), V4-03 (`@`-Picker: Tippen nach ↓ markiert den besten Treffer), R5W-03 (Paste mit führendem `/` kommt als Prompt an), R5W-02 (blockierter `FileLink`-Chunk → Pfade als Text, höchstens eine Fehlerkarte), Hervorhebung „Empfohlen“ mit `fake:context-high` (F1); `e2e/phase3-files.spec.ts:119` robuster (3 s bei 2-s-Poll, R5W-11); Bundle nach der Methode aus WP-60 §2.5 und R5-web (Summe aller Start-Chunks gzip, `index` gegen `109c073`), Werte im Ergebnis; voller `pnpm e2e` 2× (1× unter Last) |

## 3. Zurückgestellt (Koordinator)

- **Composer bei reinen Hintergrund-Tasks** (WP-60-Follow-up, V4: Stop, „Einreihen“, „Jetzt senden“
  sichtbar, aber ohne laufenden Turn wirkungslos): erst live in WP-61 klären, was die CLI bei
  laufendem Hintergrund-Agenten meldet und annimmt (V4 „Hinweise für WP-61“ Nr. 5); danach
  entscheiden.
- **Nackte Dateinamen** (`README.md` ohne Trenner, WP-60-Follow-up): bewusst nicht verlinkt (viele
  Fehltreffer in Fließtext); erneut prüfen, wenn WP-61 echten Bedarf zeigt.
- **R5W-08** (Zustand je Session aufräumen: `localStorage`-Schlüssel, Pastes, Anhänge, Opener):
  nach WP-61 als eigenes kleines Paket mit zentralem Haken in `state` (R5-web-Empfehlung).
- **Doppelte Helfer** `stopTask` (`transcript`/`tasks`), eigener `/api/file`-Leser und Plan-Datei-Scan
  (`decisions`): nach Phase 3 als Aufräum-Paket (gemeinsamer Ort `src/web/state` bzw. `src/web/lib`).
- **`TASK_STOP_BASH`**: bleibt `true`, bis WP-61 (L4) das Gegenteil zeigt.

## 4. Live-Prüfpunkte für WP-61

Sammelt der Koordinator nach der Fix-Runde in `docs/wp/WP-61.md` aus „Hinweise für WP-61“ von R5
(6), R5-web (9) und V4 (8) sowie den Ergebnissen F1–F6.

## 5. Ergebnisse

Je Paket eine eigene Datei `docs/wp/FIX-R5-F1.md` … `FIX-R5-F6.md`: je Befund „behoben“ (Fix + Test,
Gegenprobe) oder „zurückgestellt“ (Grund), Entscheidungen, Checks, Live-Prüfpunkte für WP-61,
Wünsche an den Koordinator.
