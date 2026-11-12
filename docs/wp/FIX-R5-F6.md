# FIX-R5-F6 – E2E/Bundle (Ergebnis)

> Fix-Runde nach R5/R5-web/V4 (Phase 3), Paket **F6** (Welle Fb) laut `docs/wp/FIX-R5.md` §2.
> Worktree `.worktrees/fix-r5-f6`, Branch `fix/r5-f6`, Basis `feature/phase-3` = `0634a1a` (K und
> F1–F5 gemergt). Besitz-Pfade: `e2e/**` (ohne Live-Lauf), `scripts/bundle-budget.ts`, dieses
> Dokument. Der Agent wurde vor dem Abschluss angehalten (Rechner-Last, ADR-154); Lauf 3, Checks und
> Commit hat der Koordinator übernommen. Kein Live-`claude`, keine Desktop-Bedienung, nie `%LOCALAPPDATA%\Parallax`. Keine Datei
> außerhalb dieser Pfade geändert (die Gegenprobe §2.3 hat Quellen nur vorübergehend verändert und
> per `git checkout` zurückgesetzt).

## 1. Ausgangslage

Erster voller `pnpm e2e` auf `0634a1a` vor jeder Änderung: **59/60 grün, 1 rot** (204 s) –
`phase2-new-session.spec.ts:109` erwartete die alte Fake-CLI-Version `2.1.300` (F1 hat sie auf
`2.1.322` gehoben). Alle übrigen Fälle überstanden die Fa-Änderungen (Pfadkürzung vom Anfang in
Panel/Viewer F4, `de` lazy F5, neue Verweis-Regel F2, @-Picker-Rangfolge F3) ohne Anpassung.

## 2. E2E

### 2.1 Angepasste Fälle

| Datei › Fall | Änderung | Grund |
|---|---|---|
| `phase2-new-session` › profiles (`:109`) | „Profil testen“ erwartet `FAKE_CLAUDE_VERSION` (Import aus `src/server/backend/fake/defaults.ts`) statt `'2.1.300'` | F1/V4-05: Fake-CLI = SDK-Erwartung `2.1.322`; die Konstante folgt künftigen SDK-Upgrades (deren Test in `integration.test.ts` vergleicht mit dem SDK) |
| `phase3-files` › viewer (`:119`, R5W-11) | Die 3-s-Grenze „Änderung auf der Platte → Viewer“ misst jetzt die **Seite**: `recordTextShown` (neu, `support/files.ts`) merkt per `MutationObserver` den Zeitpunkt (`Date.now()`), zu dem der neue Text erscheint; Startpunkt = vor dem `writeFile`. Gewartet wird mit dem normalen Expect-Timeout, danach `Latenz ≤ 3000 ms` geprüft; die Latenz steht als Annotation im Bericht | Vorher `toContainText(…, { timeout: 3000 })`: Playwright wiederholt eine Prüfung mit wachsenden Pausen (bis 1 s); ab ≈ 1,85 s liegt zwischen zwei Prüfungen 1 s, was nach ≈ 2,85 s erscheint, sah die Assertion nicht mehr rechtzeitig – dazu die Laufzeit der Prüfungen selbst unter Last. Bei 2-s-Poll blieb so kaum Spielraum (R5W-11 „knapp“). Die normative Grenze (WP-60 §1 Nr. 1) bleibt unverändert, gemessen wird nur ohne diesen Verzug |

### 2.2 Neue Fälle

| Datei › Fall | Befund | Prüft |
|---|---|---|
| `phase3-files` › paths with spaces and umlauts | **V4-01** (F2) | Projektordner `NN-Projekt mit Leerzeichen äöü` mit `README.md`, `Meine Notizen.txt` und `Unter Ordner\Plan für später.md`; Echo mit dem absoluten Pfad im Fließtext, dem Pfad mit Leerzeichen im Dateinamen in Backticks und einem Markdown-Link `[the plan](<C:/…/Plan für später.md>)` → genau **3** `file-link`-Elemente, alle `data-state="link"` (kein `refused`/`missing`/`checking`-Präfix wie „…\NN-Projekt“), Text = ganzer Pfad bzw. Linktext; jeder öffnet den Viewer (Markdown bzw. Text, Inhalt geprüft) |
| `phase3-composer` › pasted "/" … (R5W-03) | **R5W-03** (F3, Koordinator `e38a344`) | 40-Zeilen-Paste, erste Zeile `/clear --all`, am Feldanfang → Feld beginnt mit dem Token; nach „ what failed?“ und Enter: Fake-Antwort „received 1 paste(s)“; der gesendete `session.sendPrompt` (WS-Mitschnitt, zod) ist **genau** `U+200B + Paste + "\nwhat failed?"` (auch V4-07), `trim()` beginnt nicht mit `/`, `prompt.pastes` = [Paste]; in der Nutzer-Blase steht U+200B vor `/clear` mit **Breite 0** (Range-Messung); Sessiontitel (Sidebar-Zeile und Kopfzeile) = `/clear --all` ohne U+200B |
| `phase3-composer` › @ picker (V4-03) | **V4-03** (F3) | Projekt ohne Git mit den Dateien des V4-Repros (drei `docs/…`, tiefer Pfad `verschachtelt/…/mit-einem-sehr-langen-…-und-mehr.md`, `Grüße-Übersicht.txt`): `@` → 5, 2× ↓ → Option 2 aktiv, `grü` → **nur** `Grüße-Übersicht.txt` (kein Streutreffer), aktiv (`aria-selected`, `aria-activedescendant`), Tab fügt `@Grüße-Übersicht.txt ` ein; danach `@`, 3× ↓, `md` → 4 Treffer, **Option 0** aktiv |
| `phase3-shell` › FileLink chunk cannot be loaded | **R5W-02** (F5) | Route `FileLink-*.js` abgebrochen; `fake:files` → alle Verweise der Antwort (`app.ts:12`, `notes.md` …) und die Datei-Chips der Tool-Karte sind der leise Fallback (`data-slot="file-link-fallback"`, `data-error-kind="chunk"`), kein Link, **keine** `slot-error`-Karte; genau **ein** `[role="alert"]` auf der Seite = Hinweis `shell-slot-quiet-failure` mit „Reload window“; ein zweites Echo mit zwei neuen Pfaden (neuer Reset-Key) → wieder Text, weiter genau ein Alert |
| `phase3-plan` › plan at 75 % context | Hervorhebung „Empfohlen“ (F1 V4-05 b, ADR-147) | `fake:context-high` → Gauge der Kopfzeile `aria-valuenow=75`; `fake:plan` → Punkt am ▾ (`choice-menu-indicator`), Hauptknopf `data-fresh="false"` (nie vorausgewählt); im Menü Badge „Recommended“ mit „Context is 75% full.“, Schalter `aria-checked="false"`; Schalter an → Menü bleibt offen, nach Esc `data-fresh="true"` und kein Punkt mehr |
| `smoke` › language en/de (erweitert) | optional, F5/ADR-153 | Requests auf `dictionary.de-*.js`: vor dem Umschalten keiner, nach „Deutsch“ mindestens einer |

`e2e/README.md`: Stichwort `fake:context-high`, Helfer `recordTextShown`/`textShownAt`, die neuen
Fälle je Datei, Sprach-Chunk im Smoke-Test.

### 2.3 Gegenprobe (ohne Fix rot)

Vorübergehend in den Quellen zurückgenommen (ein Build, danach `git checkout` und neuer Build):
`expandPrompt` → `expandPastes` (R5W-03), Rücksetzen von `mentionIndex` bei geändertem Suchtext
entfernt (V4-03), `fileLinkFallback` am `FileLink`-Slot entfernt (R5W-02), Inline-Code wieder über
`findFileRefs` (V4-01), Schwelle „Empfohlen“ 60 → 80 % (Hervorhebung). Ergebnis: **alle 5 neuen
Fälle rot**, jeweils an der erwarteten Stelle (gesendeter Text ohne U+200B; Option 0 nicht aktiv nach
↓↓↓ + `md`; 2 statt 3 Links; kein Punkt am ▾; 0 Fallbacks, stattdessen Karten).
Der V4-03-Teil mit nur einem Treffer (`grü`) wäre allein nicht rot geworden (der Index wird auf die
Liste begrenzt) – deshalb der zweite Teil mit vier Treffern.

### 2.4 Läufe

Alle Läufe: `pnpm e2e` (3 Worker, Chrome headless, `--reporter=list,json`), 65 Fälle = 60 bisherige
+ 5 neue (dazu die Erweiterung im Smoke-Test). Gesamt = Wanduhr inkl. Global-Setup (Build-Prüfung).

| Lauf | Last | Ergebnis | Playwright | gesamt | Phase-3-Fälle (Summe) | Live-Änderung (gemessen) |
|---|---|---|---|---|---|---|
| 1 | keine | **65 passed** | 4,1 min | 244 s | 117,7 s | 1 956 ms |
| 2 | parallel `pnpm check` (tsc, ESLint, Vitest 286 Dateien/4 879 Tests – grün, 289 s) | **65 passed** | 4,9 min | 296 s | 114,0 s | 1 889 ms |
| 3 | keine – Endstand (Merge `062de38`, ADR-154: niedrige Priorität), Koordinator | **65 passed** | 3,0 min | 181 s | – | – |

Lauf 2 lief noch nach der alten Vorgabe „1× unter Last“ (FIX-R5 §1). Danach fror der Rechner des
Nutzers mehrfach ein; der Koordinator hat F6 abgebrochen und Lastläufe abgeschafft (**ADR-154**,
CLAUDE.md „Ressourcen“). Lauf 3 (Koordinator, `--reporter=list`, daher ohne Einzelzeiten) prüft den
Endstand nach dem Merge der Ressourcen-Regel: CPU im Mittel 21 %, höchstens 40 %.

Neue Fälle (Lauf 1 / Lauf 2): V4-01 4,1 / 4,3 s, R5W-03 3,0 / 2,4 s, V4-03 1,5 / 3,0 s, R5W-02 9,8 /
5,3 s, „Empfohlen“ 7,0 / 6,2 s. Längste Fälle unverändert `transcript.spec.ts` (b) (≈ 78 s, wie auf
der Basis 1,2 min), `phase2-sessions` „three sessions“ (≈ 47 s), `windows` „two windows“ (≈ 31 s).
Zur Last: CPU-Stichproben (`Win32_Processor.LoadPercentage`, alle 10 s) während Lauf 2 meist
10–30 %, Spitzen 40–56 % (19 logische CPUs).

## 3. Bundle

### 3.1 Methode und Skript

Start-Chunks = Entry-Skript + alle `<link rel="modulepreload">` aus `dist/web/index.html` (was der
Browser vor dem ersten Render lädt), Größe raw und gzip (zlib Stufe 9) – dieselbe Methode wie
WP-60 §2.5, R5-web R5W-01 und FIX-R5-F3/F5. Neu **`scripts/bundle-budget.ts`** (liest nur
`dist/web`, baut nichts):

```powershell
pnpm build
pnpm exec tsx --tsconfig tsconfig.tools.json scripts/bundle-budget.ts          # Tabelle + Prüfung
pnpm exec tsx --tsconfig tsconfig.tools.json scripts/bundle-budget.ts --lazy   # + größte Lazy-Chunks
```

Prüfungen (Exit-Code 1 bei Verstoß, 2 ohne Build): `index` wächst gegenüber `109c073` um höchstens
10 kB raw (WP-60 §1 Nr. 11); die **Summe aller Start-Chunks** ebenso (R5W-01: ein Modul, das nur von
`index` in einen neuen Start-Chunk wandert, spart nichts); kein `dictionary.*`-Chunk unter den
Start-Chunks (ADR-153). Kein Eintrag in `package.json` (Wunsch §6).

### 3.2 Werte (`pnpm build` dieses Stands, Bytes)

| Stand | `index` raw | `index` gzip | Start gesamt raw | Start gesamt gzip | Dateien |
|---|---|---|---|---|---|
| `109c073` (WP-60-Basis) | 383 072 | 110 409 | 879 955 | 261 337 | 4 |
| `87def00` (vor Fa, aus F3/F5) | 442 830 | 128 779 | 943 552 | 280 953 | 5 |
| **`fix/r5-f6`** (= `0634a1a` + E2E) | **379 369** | **111 247** | **879 645** | **263 425** | 6 |
| Δ gegen `109c073` | **−3 703** | **+838** | **−310** | **+2 088** | +2 |
| Δ gegen `87def00` | −63 461 | −17 532 | −63 907 | −17 528 | +1 |

Start-Chunks im Einzelnen: `index` 379 369 / 111 247, `react` 218 809 / 67 431, `vendor` 279 035 /
83 416, `rolldown-runtime` 716 / 428, `button` 1 579 / 761, `cn` 137 / 142. `index` enthält die
Build-Kennung (ein uncommitteter Stand ist ≈ 15 B länger, `….dirty-<digest>`).

- **Budget eingehalten:** `index` liegt raw unter der Basis (+838 B gzip), die Summe der Start-Chunks
  ebenfalls (+2,1 kB gzip: neue lucide-Icons in `vendor`, seit Phase 3 `button` und `cn` als eigene
  Start-Chunks). Die Phase-3-Überschreitung aus WP-60 (+59,7 kB raw) ist durch F2/F3/F5 vollständig
  zurückgenommen (F5 `de` lazy −59,2 kB, F2 `todoProgress` −2,3 kB, F3 Composer-Teile −1,9 kB).
- Lazy (raw / gzip): `dictionary.de` 62 764 / 21 328, `FileLink` 5 028 / 2 280, `FilePanel`
  12 150 / 4 330, `FilesPanel` 4 904 / 1 989, `CodeView` 3 316 / 1 677, `PdfView` 1 090 / 589,
  `TasksPanel` 10 338 / 3 504, `TaskStrip` 2 272 / 1 117, `todos` 1 131 / 603, `PlanPanel`
  18 569 / 6 286, `PlanDiff` 1 276 / 694, `SidePanelFrame` 6 426 / 2 685, `FileMentionMenu`
  2 173 / 958, `PasteChips` 2 778 / 1 384, `folders` 312 / 245, `file-refs` 6 172 / 2 555.

### 3.3 Bewertung `cn-*.js` (137 B, F3)

`cn-*.js` enthält nur `src/web/lib/cn.ts` (`twMerge(clsx(…))`, Importe aus `vendor`). Rolldown legt
das Modul seit F3 in einen eigenen Chunk, weil es vom Start-Chunk **und** von vielen Lazy-Chunks
(`FileMentionMenu`, `PasteChips`, `FilePanel`, `PlanPanel`, `TranscriptView` …) importiert wird –
wie schon `button-*.js` (WP-60). Kosten: ein zusätzlicher `modulepreload`-Request (parallel zu den
anderen, lokaler Server) und 142 B gzip – **praktisch ohne Wirkung, kein Handlungsbedarf**.

Falls gewünscht (Root-Config `vite.config.ts`, Koordinator): eine weitere `$initial`-Gruppe für die
kleinen geteilten App-Module, z. B. `{ name: 'shared-ui', test: /[\\/]src[\\/]web[\\/](?:lib[\\/]cn\.ts|ui[\\/]button\.tsx)$/, tags: ['$initial'], priority: 1 }`.
Probe (Vite-API mit der Repo-Config plus dieser Gruppe, Ausgabe nur im Scratchpad): **5 statt 6**
Start-Dateien (`cn` + `button` in einem Chunk 1 597 / 769), Summe 879 450 / 263 267 (−195 raw /
−158 gzip gegenüber dem Build desselben Stands). Nur `cn` allein in eine Gruppe benennt den Chunk lediglich um (6 Dateien). Die
bestehende `vendor`-Gruppe nimmt das Modul über eine zusätzliche Gruppe gleichen Namens nicht auf
(Rolldown legt dann einen zweiten Chunk `vendor-*.js` an); dafür müsste ihr `test` selbst erweitert
werden – nicht geprobt.

## 4. Entscheidungen

1. **Zeitgrenzen in der Seite messen** (`recordTextShown`): Die normative 3-s-Grenze bleibt, nur der
   Verzug der Assertion-Wiederholung fällt weg; gewartet wird mit dem normalen Expect-Timeout, die
   gemessene Latenz steht als Annotation im Bericht. Keine Lockerung der Grenze, kein Retry.
2. **Gegenprobe über zurückgenommene Fixes im eigenen Build** statt über einen alten Stand: ein Build
   mit fünf gezielten Rücknahmen zeigt, dass jeder neue Fall genau den behobenen Fehler fängt; die
   Quellen wurden danach per `git checkout` zurückgesetzt und neu gebaut.
3. **Budget-Skript ohne `package.json`-Eintrag**, Prüfung auch der Summe aller Start-Chunks und der
   `de`-Auslagerung; Aufruf über `pnpm exec tsx`.

## 5. Checks

Endstand (Worktree nach Merge von `feature/phase-3` = `062de38`, Koordinator):

- `pnpm check` grün: typecheck, lint, Vitest 286 Dateien / **4 881 Tests** (87 s; CPU im Mittel 27 %,
  höchstens 68 %, freier Speicher ≥ 34,7 GB).
- `pnpm build` grün; `scripts/bundle-budget.ts --lazy`: **OK – within budget** (Werte §3.2; `index` gzip
  111 250 statt 111 247 durch die längere Build-Kennung).
- `pnpm e2e` grün: Läufe 1–3 je **65 passed** (§2.4).
- Alle Läufe nacheinander, nie gleichzeitig (ADR-154).

## 6. Live-Prüfpunkte für WP-61

1. **V4-01:** echtes Projekt unter einem Ordner mit Leerzeichen/Umlauten (z. B. `C:\Users\Vorname
   Nachname\…`, „OneDrive - Firma“): Claude-typische Ausgaben mit absoluten Pfaden im Text, in
   Backticks und als Markdown-Link → verlinkt, Viewer öffnet; nie ein gepunktetes Präfix.
2. **R5W-03:** echten Log mit `/clear …` bzw. `/c/Users/…` am Feldanfang einfügen, senden → die CLI
   antwortet als Modell (kein Befehl); Blase ohne sichtbares Zeichen vor `/`; Sessiontitel ohne
   unsichtbares Zeichen (z. B. per Umbenennen-Feld prüfen: Cursor springt nicht über ein Leerzeichen).
3. **„Empfohlen“:** echte Session über 60 % Context, Plan anfordern → Punkt am ▾ und Badge im Menü,
   „Mit frischem Kontext“ nicht vorausgewählt (Fake-E2E deckt die Anzeige ab, nicht die echte Gauge).
4. **R5W-02 im Build:** Dev-Instanz (eigenes `PARALLAX_HOME`) offen lassen, neu bauen, dann ein
   Transkript mit vielen Pfaden öffnen → Text statt Links, **ein** Hinweis „Reload window“ (der E2E
   blockiert den Chunk per Route – live ist es der neue Hash nach dem Build).
5. **Live-Änderung im Viewer:** Datei im echten Editor speichern → Viewer zeigt den neuen Inhalt ≤ 3 s
   (E2E misst im Fake typisch ≈ 1,9–2,0 s: Lauf 1/2 1 956 / 1 889 ms).
6. **V4-03:** @-Picker in einem großen Repository – Antwortzeit beim Tippen und Reihenfolge (F3 §6).

## 7. Wünsche an den Koordinator (mit Entscheidung)

- `scripts/README.md`: Zeile `bundle-budget.ts` – **erledigt** (Koordinator, mit diesem Commit). Ein
  Eintrag `"bundle"` in `package.json` – **zurückgestellt** (Aufruf über `pnpm exec tsx` genügt).
- `vite.config.ts` (optional, §3.3): `cn` + `button` in einer `$initial`-Gruppe – **nicht umgesetzt**
  (Wirkung vernachlässigbar).
- `docs/wp/WP-61.md`: Live-Prüfpunkte §6 – **schon enthalten** (B11, B21–B23, B28, B29; `23fa4ef`).
- Keine neuen Abhängigkeiten, keine Contract-Änderung.
