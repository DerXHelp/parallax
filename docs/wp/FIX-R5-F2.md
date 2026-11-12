# FIX-R5-F2 – Transkript/Tasks (Fix-Runde nach R5/R5-web/V4)

> Paket F2 aus `docs/wp/FIX-R5.md` §2, Worktree `.worktrees/fix-r5-f2`, Branch `fix/r5-f2`, Basis
> `feature/phase-3` = `87def00`. Befunde: `docs/wp/V4.md` (V4-01, V4-07), `docs/wp/R5-web.md`
> (R5W-01 Anteil, R5W-04 (3), R5W-05, R5W-06 Anteil, R5W-07, R5W-11 Anteil), WP-60 §2.7 Nr. 4
> (Flake `renderers.test.tsx`). Pfade: `src/web/features/{transcript,tasks}/**`,
> `src/web/lib/file-refs.ts` (+ Test). Kein Live-`claude`, keine Contract-Änderung.

## 1. Befunde

### SOLLTE und Flakes

| Befund | Ergebnis | Fix | Test (Gegenprobe) |
|---|---|---|---|
| **V4-01** Absolute Pfade mit Leerzeichen werden zerlegt, ein Präfix-Stück wird `refused` | behoben | **Erkenner** (`lib/file-refs.ts`): `extendOverSpaces` setzt einen Laufwerks- bzw. Git-Bash-Pfad im Fließtext über einzelne Leerzeichen fort – Regel siehe Entscheidung 1. Neu `findCodeRefs(code)`: ein Inline-Code-Span ist als Ganzes ein Pfad (Leerzeichen überall, auch im Dateinamen), sonst gelten die Fließtext-Regeln (Befehl mit Pfad). **Markdown-Anbindung:** `LinkedText` (Inline-Code) nutzt `findCodeRefs`; `preserveWindowsPaths` schützt Backslashes auch hinter einem Leerzeichen im Ordnernamen (`C:\Users\Max Mustermann\.claude` verlor sonst das `\` vor `.claude`) | `file-refs.test.ts`: 19 Fließtext-Fälle (u. a. `C:\Program Files\nodejs\node.exe`, `…\Projekt mit Leerzeichen äöü\README.md:12.`, `(…\)`, `Program Files (x86)`, Git Bash, Anführungszeichen) mit Gegenproben (`C:\a\b.ts and c.md` → nur `C:\a\b.ts`; `C:\a\b.ts and src\c.md` → zwei Verweise; `… and C:\x` endet am Doppelpunkt; **kein Präfix**: Projektordner ohne Datei, `My File.txt` im Fließtext, `The folder C:\work contains a.ts`, `C:\Program Files\nodejs`, `and/or`, `- done` → `[]`), Positionen, Auflösung; 14 Code-Span-Fälle (Ganzes; Befehl, `tool.exe --help`, zwei Pfade, Tab, Anführungszeichen, UNC → Fließtext-Regeln) + Position. `Markdown.test.tsx` (+1: Text, `.claude` hinter Leerzeichen, Code-Spans, Absatz ohne jeden Präfix-Verweis). `windows-paths.test.ts` (+3). **Gegenprobe:** alter Erkenner/alte Anbindung → 43 rot (alle neuen Fälle außer den Gegenproben, die schon vorher stimmten) |
| **Flake** `renderers.test.tsx` (jsdiff-Fallback, WP-60 §2.7 Nr. 4) | behoben | `beforeAll` lädt `diff` vorab (180 s Hook-Limit, Muster „Warm-up“ aus FLAKES.md – der Test nimmt weiter den asynchronen Weg, der Zeilen-Cache ist leer); `findByText(…, LAZY)` mit 15 s auch im `ToolInputPreview`-Fall (gleicher Lazy-Weg) | **Gegenprobe** mit einem Wegwerf-Test, der `import('diff')` per `vi.mock` um 6 s verzögert (wie unter Last): alter Ablauf rot nach 5,1 s („Unable to find …“), neuer grün |
| **R5W-04 (3)** `TaskStrip.test.tsx:114`: `find`-Timeout 10 s > Testlimit 5 s | behoben | `vi.setConfig({ testTimeout: 30_000 })` für die Datei (Kommentar mit Grund) | **Gegenprobe:** Store-Update im Slot-Test vorübergehend um 6 s verzögert – ohne Datei-Limit „Test timed out in 5000ms“, mit grün |
| **R5W-01 Anteil** `tasks/lib/rows.ts` im Start-Chunk | behoben | `todoProgress` → neu `lib/todo-progress.ts` (einziges statisches Modul in `index.ts`); `useTodos` → neu `state/todos.ts`, damit auch der Leisten-Chunk `rows.ts` nicht über `state/tasks.ts` zieht | `lib/todo-progress.test.ts` (aus `rows.test.ts` verschoben, +1 Fall leeres `activeForm`); Messung unten |

**R5W-01 – Messung** (`pnpm exec vite build`, Zuordnung je Quelle über die Sourcemap, Skript im
Scratch-Ordner):

| | vorher (`87def00`) | nachher |
|---|---|---|
| `index-*.js` raw | 442 830 B | 440 565 B (−2 265) |
| `index-*.js` gzip (Vite) | 129,84 kB | 129,18 kB |
| `index-*.js` gzip -9 | 128 779 B | 127 982 B (−797) |
| `tasks/lib/rows.ts` im `index` | 2 909 B | – (nur `TasksPanel-*.js`, 2 607 B) |
| `tasks/lib/todo-progress.ts` im `index` | – | 340 B |
| Lazy: `TasksPanel` / `TaskStrip` / gemeinsamer Chunk | 6,89 / 2,23 / 1,85 kB (`tasks-*`) | 10,30 / 2,27 / 1,13 kB (`todos-*`: `TodoItems`, `useTodos`) |

Im `index` kamen die neuen Schlüssel der Wörterbücher hinzu (`tasks` +120 B, `transcript` +204 B
en+de); `de` wird mit F5 (ADR-153) ohnehin lazy.

### NIT

| Befund | Ergebnis | Fix | Test |
|---|---|---|---|
| **R5W-05** `EMAIL_PATTERN` quadratisch | behoben (erweitert) | Lookbehind `(?<![\p{L}\p{N}._%+-])` (gleiche linkeste Treffer, also gleiche Maskierung) + Vorfilter `includes('@')`. Beim Messen zusätzlich gefunden und behoben: `URL_PATTERN` (Schema `[A-Za-z0-9+.-]*` ab jedem Buchstaben nach `.`/`-` neu gescannt → Schema auf 32 Zeichen begrenzt), `trimEnd` (zählte Klammern je entferntem Zeichen neu → einmal zählen), `EXTENSION`-Regex (→ linearer Helfer `hasExtension`) | `file-refs.test.ts` „linear time“ (7 Eingaben, je < 250 ms; vorher 0,8 / 0,8 / 2,3 / 5,7 / 16,7 s für Wort ohne `@`, Label-Kette, `b.b.…`, `a-a-…`, 50 000 `)`) – **Gegenprobe** rot |
| **R5W-06 Anteil** `.join(' · ')` in `TasksPanel`/`TaskStrip` | behoben | Schlüssel `tasks.panel.summary` (`{running} · {recent}`), `tasks.strip.line` (`{progress} · {active}`), en+de | bestehende Tests (Texte unverändert), `tasks/i18n` (Platzhalter gleich) |
| **R5W-07** Fokus nach „Alle stoppen“ | behoben | Schließt die Rückfrage (Abbrechen oder Stoppen), geht der Fokus auf „Alle stoppen“; ist der Knopf weg, auf das Panel (`role="region"`, `tabIndex=-1`) | `TasksPanel.test.tsx`: Enter auf „Abbrechen“ → Fokus auf „Alle stoppen“; nach „Alle stoppen“ → Panel – Gegenprobe rot (Fokus auf `body`) |
| **R5W-11 Anteil** feste Wartezeiten `TranscriptView.test.tsx` | behoben | `scrollSettled(region)`: wartet, bis 200 ms lang kein `scroll` kam; der Timer wird bei jedem Ereignis nach dem von virtua gesetzt (dessen Fenster 150 ms) und Timer laufen in Fälligkeitsreihenfolge – unabhängig von der Last. Ersetzt 20 ms (×2) und 250 ms | **Gegenprobe** mit eingebautem Fehler (Liste 150 ms nach neuem Item zurück ans Ende): alter Test falsch grün, neuer rot |
| **R5W-11 Anteil** Bash-Stop-Flag am Panel | behoben | – | `TasksPanel.test.tsx`: `TASK_STOP_BASH` aus (über `canStopTask`) → Bash-Zeile ohne Stop, „Alle 2 … stoppen“ ohne Bash |
| **R5W-11 Anteil** Strip-Zustand mit zwei Sessions | behoben | – | `TaskStrip.test.tsx`: Auf/Zu je Session, gleicher Strip wechselt die Session (abgeleiteter Zustand), Speicher je Schlüssel |
| **V4-07 Anteil** lange Nutzer-Nachricht | behoben | Ab 14 Zeilen bzw. 2000 Zeichen zugeklappt: erste 8 Zeilen (≤ 800 Zeichen), Knopf „Alle n Zeilen anzeigen“/„Weniger anzeigen“ (`aria-expanded`), Zustand über `state/expansion` (übersteht die Virtualisierung); `lib/text.ts` `collapsedPreview`; Playground `transcript/media` mit 42-Zeilen-Log | `lib.test.ts` (+1), `phase2.test.tsx` (+2: zugeklappt, auf, Re-Mount, kurz ohne Knopf) |

Nebenbei: `phase2.test.tsx` (zwei vorhandene Zeilen) und alle geänderten Dateien Prettier-konform;
`TasksPanel.test.tsx` mit Datei-Limit 30 s (viele Klicks, vorbeugend nach FLAKES.md); Playground
`transcript/files` mit einer Zeile „Spaces (V4-01)“.

### Zurückgestellt

- **Stat-Kürzung auf den längsten existierenden Präfix** (V4-Vorschlag): Stat-Prüfung und Slot
  `FileLink` gehören dem Dateien-Feature. Der Erkenner ist stattdessen vorsichtig und meldet einen
  mehrdeutigen Präfix gar nicht. Falls WP-61 Bedarf zeigt: Slot mit Kandidatenliste (längster
  existierender gewinnt) – Slot-/Contract-Änderung, Koordinator.
- **Bekannte Grenzen der Fließtext-Regel** (mit Tabellenfällen bewusst nicht festgeschrieben):
  - Ein Ordnername mit „Endung“ vor einem Leerzeichen (`C:\Users\X\Node.js Projects\app.ts`) endet
    wie `C:\a\b.ts and …` – gemeldet wird `C:\Users\X\Node.js`, auch in Backticks (dort schützt
    dieselbe Regel vor `C:\x\tool.exe --help` als einem Pfad).
  - Ordner ohne Endung, dann ein Wort und ein relativer Pfad mit demselben Trenner
    (`C:\a\old and src\new.ts`) verschmelzen; meist `missing` → Text.
  - Dateinamen mit Leerzeichen im Fließtext (ohne Backticks) und Ordnerpfade ohne Endung, auf die
    ein Wort folgt, bleiben Text (kein Präfix).
  - Relative Pfade mit Leerzeichen (`docs/My Notes/a.md`) haben keinen Anker; erkannt wird nur
    `Notes/a.md` (gegen `cwd`, meist `missing` → Text).
- **V4-07 Composer-Anteil** (Zeilenumbruch nach dem Paste): F3.

## 2. Entscheidungen

1. **Leerzeichen im Fließtext nur in Ordnernamen.** Der Pfad geht über ein Leerzeichen nur weiter,
   wenn ein späteres Wort einen Trenner im Stil des Pfads enthält (`\` nach `C:\`, `/` nach `C:/`
   und `/c/`); das Ergebnis endet auf eine Datei mit Endung oder einen Trenner; ein Wort mit Endung
   vor einem Leerzeichen, ein Doppelpunkt, Satzzeichen und ein Zeilen-Suffix beenden ihn. Ein Basispfad
   ohne Endung, dem direkt ein Wort folgt, ist mehrdeutig und wird **nicht** gemeldet (kein
   verlinktes oder abgelehntes Präfix-Stück). Ein Inline-Code-Span ist als Ganzes ein Kandidat
   (Leerzeichen überall), wenn er wie ein einzelner absoluter Pfad aussieht.
2. **Kein Stat im Erkenner:** Er bleibt rein (Text → Kandidaten); lieber ein Verweis weniger als ein
   falscher. Laufzeit linear (Fortsetzung höchstens `LIMITS.pathChars`, endet am nächsten Laufwerk).
3. **Wartezeiten an Ereignisse binden:** Lazy-Chunks im `beforeAll` vorladen und explizit länger
   warten; Scroll-Ruhe statt fester Millisekunden (Reihenfolge der Timer statt Wanduhr).

## 3. Checks

- `pnpm exec tsc -b` grün; `pnpm exec eslint src/web/features/transcript src/web/features/tasks
  src/web/lib/file-refs.ts src/web/lib/file-refs.test.ts --max-warnings=0` grün; Prettier grün.
- `pnpm exec vitest run src/web/features/transcript src/web/features/tasks src/web/lib/file-refs.test.ts`:
  16 Dateien, 304 Tests grün (+ Playground-Test).
- `pnpm check` (einmal, Hintergrund): typecheck, lint und Tests grün – 279 Dateien, 4 808 Tests,
  kein Lastflake (auch nicht in fremden Dateien).
- `pnpm build` grün (Bundle-Vorher/Nachher s. R5W-01).
- Sichtprüfung (Playwright headless, `pnpm dev:web` auf 5191, danach beendet): `transcript/files` –
  `D:\private\Mein Ordner\notes.md` als Ganzes `refused`, Code-Span `…\Mein Ordner\My File.txt` als
  Ganzes `missing`, `…\Projekt mit Leerzeichen` ohne Verweis, `README.md and c.md` nur `README.md`
  verlinkt; `transcript/media` – Log zugeklappt („Show all 42 lines“), Klick klappt auf; 0
  Konsolenfehler.

## 4. Live-Prüfpunkte für WP-61

1. **V4-01 live** in einem Projekt unter einem Ordner mit Leerzeichen/Umlauten: Claude-typische
   absolute Pfade im Text, in Backticks und als Markdown-Link → verlinkt, Viewer öffnet; nie ein
   gepunktetes Präfix mit „Not shared with this session“. Dateinamen mit Leerzeichen ohne Backticks
   bleiben Text (erwartet).
2. **Lange Nutzer-Nachricht** nach einem echten Paste (mit dem Zeilenumbruch-Fix aus F3): zugeklappt,
   Auf/Zu übersteht Scrollen; Darstellung bei schmalem Fenster.
3. **„Alle stoppen“ per Tastatur:** Tab → Enter → Abbrechen/Stoppen; Fokus bleibt im Panel.

## 5. Wünsche an den Koordinator

- `src/web/lib/README.md` (Koordinator): `file-refs.ts` exportiert zusätzlich `findCodeRefs(code)`;
  Fließtext erkennt absolute Pfade mit Leerzeichen in Ordnernamen (Regel Entscheidung 1).
- Nach dem Merge mit F5 (ADR-153, `de` lazy): `features/{tasks,transcript}/i18n/i18n.test.ts` prüfen
  `translate('de', …)` synchron – falls `de` dann erst geladen werden muss, dort anpassen (Datei in
  meinem Pfad, die Umstellung kommt aus F5).
- F6: E2E-Fall V4-01 (Text, Backticks, Markdown-Link) wie in FIX-R5 §2 geplant; Playground-Zeile
  „Spaces (V4-01)“ in `transcript/files` als Vorlage.
