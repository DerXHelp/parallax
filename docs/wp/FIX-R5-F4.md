# FIX-R5-F4 – Dateien/Plan (Ergebnis)

> Fix-Runde nach R5/R5-web/V4 (Phase 3), Paket **F4** laut `docs/wp/FIX-R5.md` §2. Worktree
> `.worktrees/fix-r5-f4`, Branch `fix/r5-f4`, Basis `feature/phase-3` = `87def00` (nach Paket K).
> Besitz-Pfade: `src/web/features/{files,decisions}/**`, `src/web/ui/{code-block,diff-view,copy-button}.tsx`
> (+ Test daneben), `src/web/index.css` (nur Syntax-/Link-Tokens). Kein Live-`claude`; Sichtprüfung nur
> per Playwright headless gegen `pnpm dev:web` (Port 5193, danach beendet).

## 1. Befunde

| Befund | Stand | Fix (Fundstellen) | Test (Gegenprobe) |
|---|---|---|---|
| **R5W-04 (1)** `DecisionBar.test.tsx` prüft den Plan vor dem Lazy-Chunk | **behoben** | „Open plan“-Fall wartet auf den Inhalt des Chunks: `within(panel).findByRole('heading', { name: 'Plan v2' }, LAZY)` (15 s, Muster `PlanCard.test`), statt sofort `panel.textContent` zu prüfen | Gegenprobe: Chunk `./components/PlanPanel` per `vi.mock` um 1,5 s verzögert → alte Prüfung rot mit genau dem Lastfehler `expected 'PlanFilesTasks' to contain 'Plan v2'`, neue grün. Unter Last vorher 6/6 rot, nachher 0/12 (Tabelle §3) |
| **R5W-04 (2)** `FilePanel.test.tsx` (V4: unter Last 3/3 rot) | **behoben** | Datei-Limit `vi.setConfig({ testTimeout: 30_000 })`; `beforeAll` lädt die Lazy-Chunks `CodeView`/`PdfView` vorab (Hook 120 s); `findBy*`/`waitFor` auf Lazy-Inhalt (Code-Region, Zeilen, PDF-Frame, Lightbox, Bild) mit `LAZY` 15 s. Dazu zwei latente Rennen ohne Wanduhr: „errors … Try again“ und der neue Fall „gelöschte Datei“ laufen mit gefälschtem `setInterval` (sonst zählt bzw. verbraucht ein 2-s-Poll unter Last den vorbereiteten `file.stat`) | Lastlauf vorher: alle 6 Läufe rot (Markdown 6×, image 6×, text 2×, reload 1×), nachher 0/12 rot; „gelöschte Datei“ war im ersten Nachher-Lauf 2/6 rot (Poll-Rennen), mit Fake-`setInterval` 0/6 |
| R5W-04 (2), gleiche Ursache in weiteren `files`-Tests | **behoben** | Im selben Lastlauf ebenfalls rot: `index.test.tsx` (6/6) → Datei-Limit 30 s, `beforeAll` importiert `./FileLink` vorab (React.lazy suspendiert trotzdem einmal – der Klartext-Fallback wird weiter geprüft), `find` 15 s; `playground.test.tsx` (4/6, `findByRole` nach 5 s) → `LAZY` 30 s; `FilesPanel.test.tsx` (3/6) → 30 s. Vorbeugend (unter Last bis 4,4 s bzw. 3,9 s): `FileLink.test.tsx`, `CodeView.test.tsx` → 30 s | Lastläufe §3 |
| **V4-04** Kontrast Code-Schlüsselwörter (dunkel 3,94:1) und Inline-Code-`FileLink` (hell 4,41:1) | **behoben** | `index.css`: neue Tokens `--syntax-keyword` (hell `oklch(0.52 0.18 295)`, dunkel `oklch(0.72 0.15 295)`) und `--link` (hell `oklch(0.52 0.14 40)`, dunkel `var(--brand)`) + `--color-link`; `--profile-violet` und `--brand` unverändert. `ui/code-block.tsx` `SHIKI_TOKENS` → `var(--syntax-keyword)`; `FileLink` inline `text-link`/`decoration-link`. Zusätzlich: markierte Zeile der Codeansicht `bg-warning/10` statt `/15` (dort lagen hell Strings 4,39:1 und Funktionen 4,34:1) | Werte §4 (gerechnet und in Chrome gemessen); `ui/code-block.test.ts` (Token statt Profilfarbe), `FileLink.test.tsx` (`text-link`); vorher/nachher in Chrome gemessen |
| **V4-06 (a)** zwei Größenformate („564 byte“ binär vs. „8 bytes“ dezimal) | **behoben** | `FilePanel` nutzt `formatFileSize` aus `@web/lib/bytes` (Kopf und Hinweis „gekürzt“); `features/files/lib/format.ts` (`formatBytes`, `scaleBytes`) und sein Test gelöscht | `FilePanel.test.tsx`: Kopf `\d{1,3} bytes`, Hinweis „only the first **2.1 MB**“ (`LIMITS.fileTextBytes` = 2 MiB = 2 097 152 B dezimal); Formatierer selbst: `lib/bytes.test.ts` (Paket K) |
| **V4-06 (b)** lange Pfade am Ende gekürzt (Endung weg) | **behoben** | Neu `components/PathText.tsx`: einzeilig, **vom Anfang** gekürzt (`…\proj\Projekt mit Leerzeichen äöü`) – Box `direction: rtl` (Ellipse links), Pfad als isolierter LTR-Lauf `<bdi dir="ltr">` (Trenner bleiben in Ordnung; Auswahl, Kopieren, Screenreader: voller Pfad). Viewer-Kopf: Name `shrink-0` ganz, danach der **ganze** Ordner (statt `pathTail(…, 3)`) als `PathText`, der zuerst weicht; Dateien-Panel: Name ganz, relativer bzw. absoluter Pfad als `PathText` | `FilePanel.test.tsx` „a long path …“ (Struktur, `bdi dir=ltr`, voller Ordner); bestehende Text-Erwartungen unverändert; Playwright: `…er\.claude\plans\sample.md`, `…de\tasks\task_01.output`, Kopf `README.md …ork\sample` (beide Themes) |
| **V4-06 (c)** gelöschte Datei: alter Inhalt und Kopf ohne Hinweis | **behoben** | `FileDocument.stale` (`state/file-document.ts`): scheitert `file.stat` nach einem Erfolg, sind Metadaten/Inhalt der letzte bekannte Stand; scheitert nur der Text, ist ein älterer Text veraltet. Kopf: Badge „Last known state“/„Letzter bekannter Stand“ (`warning`, erstes Element der Metazeile), `data-stale` am Viewer; der alte Inhalt bleibt lesbar, Erfolg setzt zurück | `file-document.test.ts` (stat-Fehler → `stale`, Erfolg → zurück; Fehler ohne frühere Antwort nicht `stale`; Text-Fehler mit altem Text), `FilePanel.test.tsx` „a deleted file …“ |
| **R5W-06** (Anteil) `FileLink`-Tooltip mit literalem Trenner | **behoben** | Schlüssel `files.link.tooltip` `'{path} – line {line}'` / `'{path} – Zeile {line}'` statt `` `${path} – ${t('files.link.line')}` ``; `files.link.line` entfernt | `FileLink.test.tsx` (Tooltip-Text unverändert) |
| **R5W-09** (Anteil) eigene Kopie `isLocalSession` | **behoben** | `lib/actions.ts` importiert `isLocalSession` aus `@web/shell/navigation/session-actions` (liegt im Start-Chunk, kein Byte mehr im Lazy-Chunk); Kopie entfernt | bestehende `lib.test.ts`/`FileLink.test.tsx` (Remote-Host ohne Editor/Explorer) |
| **R5W-10** (Anteil) Stat-Cache benachrichtigt je `ensure` | **behoben** | `StatCache.queueNotify()`: eine Benachrichtigung je Microtask für `ensure`, `invalidate` und Antworten (`clear` bleibt synchron); der Snapshot (`peek`) ist immer aktuell | `stat-cache.test.ts` „bundles …“: 50 × `ensure` → 1 Benachrichtigung; Gegenprobe (sofort benachrichtigen) rot: 50 |
| **R5W-10** (Anteil) `file-document`: Poll-Fehler setzt alle 2 s neu | **behoben** | Derselbe Fehler (Code + Params) ohne `loading`/`busy`-/`stale`-Änderung → kein neuer Zustand, keine Benachrichtigung | `file-document.test.ts`: zwei weitere fehlgeschlagene Polls → Snapshot identisch; Gegenprobe rot (5 statt 3 Benachrichtigungen) |
| **R5W-10** (Anteil) `CodeView` ignoriert `col` | **behoben** (markiert) | `col` reist `FilePanel` → `CodeView`; auf der Zielzeile unterstreicht ein Marker (`data-slot="code-column"`, `border-warning`) die Spalte; Versatz über `lib/columns.ts` `columnOffset` (Zeichen wie im Editor, Tab bis zum nächsten Tab-Stopp 4); nach dem Sprung wird der Marker seitlich sichtbar gescrollt (`scrollIntoView` nearest). `col` bleibt im Ziel (Editor-Aktion nutzt ihn) | `CodeView.test.tsx` (Marker nur auf der Zielzeile, `calc(0.75rem + 4ch)` nach Tab, `scrollIntoView` auf dem Marker; ohne Zeile/Spalte kein Marker), `lib.test.ts` `columnOffset`, `FilePanel.test.tsx` (Zeile 11 / Spalte 4) |
| **R5W-11** (Anteil) `bar-store` ohne Test mit werfendem Storage | **behoben** | – (Code war defensiv) | `decisions/lib/lib.test.ts` „a throwing storage …“: `getItem`/`setItem` werfen → `null`/`false`, Schreiben wirft nicht, alte Werte unberührt. Hinweis: Spy auf der Instanz, ein `Storage.prototype`-Spy greift in happy-dom nicht (§5) |
| **R5W-11** (Anteil) `FileLink.test.tsx` schläft 60 ms für den 50-ms-Batch | **behoben** | `flushStats()`: erst Ops/Effekte durchlaufen lassen (0-ms-Task), dann `statCache.flush()` und die Antworten (0-ms-Task) – keine Wanduhr-Annahme mehr; den 50-ms-Timer prüft `stat-cache.test.ts` mit Fake-Timern. Keine globalen Fake-Timer, weil Radix-Tooltips und user-event echte Timer brauchen | `FileLink.test.tsx` (alle Fälle, inkl. „one batched file.statMany“) |

## 2. Entscheidungen

1. **Kürzung vom Anfang per CSS** (`direction: rtl` + `<bdi dir="ltr">`) statt Mittelkürzung mit
   Messung: kein JS, kein ResizeObserver, der volle Pfad bleibt im DOM; das Ende (nächster Ordner,
   Dateiname mit Endung) ist immer sichtbar. Der Viewer-Kopf zeigt dafür den ganzen Ordner statt der
   letzten drei Segmente.
2. **Markierte Codezeile `bg-warning/10`** statt `/15`: Mit `/15` lagen im hellen Theme Strings
   (4,39:1) und Funktionen (4,34:1) auf der markierten Zeile unter 4,5:1; die Zeile bleibt durch die
   hervorgehobene Zeilennummer und `aria-current` erkennbar.
3. **`col` markieren statt streichen** (R5W-10): `col` ist Teil von `openFile`/`FilePanelSlotProps`
   und wird von „Im Editor öffnen“ gebraucht; der Viewer unterstreicht die Spalte (Zeichen zählen wie
   im Editor, Tab = 1 Zeichen, Anzeige mit Tab-Stopps).

Weitere: „veraltet“ ist ein Zustand des Loaders (`stale`), kein neuer Fehlercode; der Hinweis
„gekürzt“ nennt `2.1 MB` (2 MiB dezimal, eine Konvention mit Composer und Limits); `FileLink.test`
nutzt `statCache.flush()` statt Fake-Timern.

## 3. Checks

| Schritt | Ergebnis |
|---|---|
| `pnpm exec tsc -b` | grün |
| `pnpm exec eslint src/web/features/{files,decisions} src/web/ui/{code-block,diff-view,copy-button}.tsx src/web/ui/code-block.test.ts --max-warnings=0` | grün |
| `pnpm exec prettier --check` (eigene Pfade) | grün |
| `pnpm exec vitest run src/web/features/{files,decisions} src/web/ui/code-block.test.ts` | grün, 20 Dateien / 220 Tests |
| `pnpm check` (einmal, parallel zu F1–F3/F5) | grün: `tsc -b` ✓, ESLint ✓, Vitest **280 Dateien / 4766 Tests** (235 s); keine Last-Flakes in fremden Dateien aufgetreten |
| `pnpm build` | grün (`dist/web` + `dist/server.js`) |

**Lastläufe** (Methode wie `docs/wp/FLAKES.md` L2: CPU-Last mit 12 Dauerlast-Threads auf 19 logischen
CPUs **plus** 6 gleichzeitige `vitest run src/web/features/files src/web/features/decisions`, dazu die
parallelen Pakete F1–F3/F5 auf demselben Rechner; Auswertung über `--reporter=json`):

| Lauf | Stand | Ergebnis |
|---|---|---|
| vorher (6 Läufe) | Basis `87def00` | **6/6 rot**, 34 Fehlschläge: `DecisionBar` R2W-15 6×, `FilePanel` 15× (Markdown 6, image 6, text 2, reload 1), `index.test` 6×, `playground.test` 4×, `FilesPanel.test` 3× |
| nachher 1 (6 Läufe) | Fixes ohne Preload in `index.test`, ohne Fake-`setInterval` | 6/6 rot, 7 Fehlschläge: `index.test` 5× (15–16 s am 15-s-`find`), neuer Fall „gelöschte Datei“ 2× (Poll-Rennen) |
| nachher 2 (6 Läufe) | Endstand | **6/6 grün, 1320/1320**; längste Fälle: Playground-Host 14,4 s (Limit 60 s, `find` 30 s), FilePanel image 13,2 s (Limit 30 s) |

Ursache des `index.test`-Anstiegs in „nachher 1“: `lib/actions.ts` importiert jetzt
`@web/shell/navigation/session-actions` (R5W-09) – im Test zieht der FileLink-Chunk damit den
Modulgraphen der Shell-Navigation nach (im Build liegt das Modul ohnehin im Start-Chunk). Der Import
läuft jetzt im `beforeAll`.

**Sichtprüfung** (Playwright headless, Chrome, `pnpm dev:web` auf 5193, Farben über ein Canvas
aufgelöst, danach Vite-Prozessbaum beendet):

| Prüfung | dunkel | hell |
|---|---|---|
| Schlüsselwort in der Codeansicht (`files/viewer-code`) | 6,99:1 (vorher 3,94:1) | 5,86:1 |
| Schlüsselwort auf der markierten Zeile | 5,76:1 | 5,09:1 |
| Inline-`FileLink` in Inline-Code (`bg-muted`) | 5,61:1 | 5,14:1 (vorher 4,41:1) |
| Dateien-Panel bei 700 px | lange absolute Pfade `…er\.claude\plans\sample.md`, `…de\tasks\task_01.output`, Namen ganz | gleich |
| Viewer-Kopf auf 360 px gequetscht | `README.md …ork\sample` (Name ganz, Ordner vom Anfang gekürzt) | gleich |

## 4. Kontrastwerte (WCAG 2, gerechnet: OKLCH → sRGB, Alpha in sRGB gemischt wie im Browser)

| Token | Theme | Hintergrund `background` | Codeblock `muted/40` | Inline-Code `muted` | markierte Zeile `warning/10` |
|---|---|---|---|---|---|
| `--syntax-keyword` `oklch(0.52 0.18 295)` | hell | 5,84 | 5,59 | 5,24 | 5,09 |
| `--syntax-keyword` `oklch(0.72 0.15 295)` | dunkel | 7,02 | 6,66 | 6,06 | 5,82 |
| `--link` `oklch(0.52 0.14 40)` | hell | 5,73 | 5,49 | 5,14 | – |
| `--link` = `--brand` `oklch(0.7 0.13 42)` | dunkel | 6,53 | 6,19 | 5,63 | – |
| zum Vergleich `--profile-violet` (alt) | hell / dunkel | 4,51 / 3,96 | 4,32 / 3,76 | 4,05 / 3,42 | – |
| zum Vergleich `--brand` (alt, Link hell) | hell | 4,94 | 4,73 | 4,43 | – |

Die übrigen Syntaxfarben (`--success`, `--warning`, `--info`, `--destructive`, `--muted-foreground`)
liegen auf allen Code-Hintergründen beider Themes über 4,5:1, mit `warning/10` auch auf der markierten
Zeile (hell Strings 4,71, Funktionen 4,66; dunkel `--destructive` 4,85).

## 5. Zurückgestellt bzw. Hinweise

- **Kontrast-Wächter als Test:** Vitest lädt kein CSS – `import.meta.glob('../index.css', { query:
  '?raw' })` liefert im Web-Projekt `''`, Node-APIs sind in `src/web` per ESLint verboten. Darum prüft
  `ui/code-block.test.ts` nur die Token-Verwendung; die Werte stehen in §4. Wunsch an den Koordinator
  (Root-Config): `test.css.include` für `src/web/index.css` oder ein Node-Projekt-Test, der die Tokens
  liest und die Kontraste rechnet (Rechnung liegt vor).
- **`Storage.prototype`-Spies in happy-dom wirkungslos**, sobald die Methode einmal benutzt wurde
  (happy-dom bindet `getItem`/`setItem` beim ersten Zugriff an die Instanz). Betrifft womöglich
  `shell/side-panel/SidePanelHost.test.tsx:273` und `shell/SidebarFrame.test.tsx:92/235` (falsch grün
  möglich) – Pfade von F5, hier nur gemeldet.
- Doppelter `/api/file`-Leser in `decisions/state/plan-data.ts` und Plan-Datei-Scan: laut FIX-R5 §3
  Aufräum-Paket nach Phase 3, unverändert.

## 6. Live-Prüfpunkte für WP-61

1. **Lange Pfade** in echten Projekten (tiefe Ordner, Leerzeichen, Umlaute) im Chrome-App-Modus bei
   125 %/150 %: Viewer-Kopf und Dateien-Panel kürzen vom Anfang, Name und Endung bleiben sichtbar;
   Dateinamen mit RTL-Schrift (falls vorhanden) bleiben lesbar (`<bdi>`).
2. **Gelöschte Datei** im offenen Viewer (im Explorer löschen): Alert + Badge „Letzter bekannter
   Stand“, alter Inhalt lesbar; Datei wiederherstellen → Badge weg nach ≤ 2 s (Poll).
3. **Spalte**: Verweis `datei.ts:12:5` aus einer Claude-Antwort → Viewer markiert Zeile 12, Spalte 5;
   eine Spalte weit rechts in einer langen Zeile wird seitlich ins Bild gescrollt.
4. **Kontrast** in echten Code-Blöcken (Transkript, Viewer, Diff) und Inline-Code-Verweisen, beide
   Themes.
5. **Größen**: Datei mit 10 000 000 B zeigt im Viewer und am Anhang-Chip „10 MB“; Hinweis bei Text
   über 2 MiB „nur die ersten 2,1 MB“.

## 7. Wünsche an den Koordinator

- Kontrast-Wächter (siehe §5): CSS im Vitest-Web-Projekt für `index.css` freigeben oder Node-Test.
- Weiterhin offen aus `docs/wp/FLAKES.md`: moderater Default-`testTimeout` im Web-Projekt – die
  Datei-Limits dieses Pakets (30 s) würden dann überflüssig.
- F5 informieren: `Storage.prototype`-Spies (§5).
