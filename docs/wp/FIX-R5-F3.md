# FIX-R5-F3 – Composer (Ergebnis)

> Fix-Paket F3 der Fix-Runde nach R5/R5-web/V4 (`docs/wp/FIX-R5.md` §2, Zeile „F3 Composer“).
> Worktree `.worktrees/fix-r5-f3`, Branch `fix/r5-f3`, Basis `feature/phase-3` = `87def00` (nach
> Paket K). Grundlage: `docs/wp/R5-web.md` (R5W-01, R5W-03, R5W-09, R5W-11), `docs/wp/V4.md` (V4-03,
> V4-07). Geänderte Pfade nur unter `src/web/features/composer/**` und dieses Dokument.

## 1. Befunde

### Behoben

| Befund | Fix | Test (Gegenprobe) |
|---|---|---|
| **R5W-03** (SOLLTE) Paste-Chip am Feldanfang umgeht die Slash-Behandlung | neu `lib/pastes.ts` `expandPrompt(text, pastes)`: beginnt der Feldtext selbst nicht mit `/` (auch nicht nach Leerraum), der expandierte Text aber schon, kommt `SLASH_GUARD` (U+200B ZERO WIDTH SPACE) davor. `Composer.sendMessage` (Enter, „Jetzt senden“, `/plan text` über `sendText`) und der Zähler (`sendLength`) nutzen ihn; die Slash-Erkennung (`classifySlash`) sieht wie bisher nur den Feldtext. Ein getipptes `/befehl [#1 …]` bleibt ein Befehl; die Pastes stehen weiter wörtlich im Text (`paste_not_in_text`) | `pastes.test.tsx` „a pasted "/clear …" goes as a prompt that does not start with "/"“ (Prompt = U+200B + Paste, `trim()` beginnt nicht mit `/`, kein Terminal-Hinweis), „neither a native nor a terminal-only command runs from a pasted text“ (`/model opus …`, `/config …`: kein `session.setModel`, kein Hinweis), „a typed command with a paste after it stays a command“; `lib/pastes.test.ts` (2 Fälle, auch eingerückter Paste). Gegenprobe: `sendMessage` mit `expandPastes` → beide R5W-03-Komponententests rot |
| **V4-03** (SOLLTE) @-Picker: aktiver Eintrag bleibt nach weiterem Tippen stehen | `Composer.tsx`: `mentionQuery` merkt den Suchtext; jede Änderung setzt `mentionIndex` auf 0 (wie das Slash-Menü) | `mention.test.tsx` „V4-03: with several matches left, the first one is active after typing“ (3× ↓, dann `src` → Option 0 aktiv). Gegenprobe: ohne Rücksetzen rot (Index 3 bleibt) |
| **V4-03** Nebenbefund: Streutreffer über tiefe Ordnernamen | `lib/mentions.ts` `matchPaths` (composer-seitig, `lib/fuzzy.ts` unverändert): nach dem Teilfolgen-Vorfilter `fuzzyFilter` **strikt** (Mindestgüte aus V3-03: Wortanfänge und Läufe müssen die Lücken bezahlen) über Dateiname **und** Pfad; danach Rang-Gruppen: (1) jeder Suchbegriff zusammenhängend im Dateinamen, (2) unscharf im Dateinamen, (3) zusammenhängend im Pfad, (4) übrige; innerhalb der Gruppe die Fuzzy-Reihenfolge | `mention.test.tsx` „V4-03: typing after ↓ makes the best match active again; Tab takes it“ (Repro aus V4: `@`, 2× ↓, `grü` → nur `Grüße-Übersicht.txt`, Tab fügt ihn ein); `lib/mentions.test.ts` „no scattered hits …“ (`grü`, `secret` gegen den tiefen md-Pfad), „file-name hits first …“. Gegenprobe: alte `matchPaths` → alle drei rot |
| **R5W-01** Anteil Composer (Start-Chunk) | `FileMentionMenu` und `PasteChips` per `React.lazy`, je in eigener `SlotBoundary` (`@web/shell/SlotBoundary`) + `Suspense fallback={null}` – der Composer ist ein eager Slot ohne Grenze, ein fehlender Chunk zeigt so nur die kleine Fehlerkarte (beim @-Menü an dessen Stelle über dem Feld). `PasteChips` wird nur gerendert, solange ein Token im Feld steht. Der erste Fokus eines Composer-Felds lädt beide Chunks vor (`preloadComposerParts`, wie `SidePanelHost`), Tastatur, Filter und Paste-Behandlung bleiben im Composer – nichts wartet auf die Chunks. `mentionMenuId`/`ProjectFilesState` nach `lib/mentions.ts`. Ordner: `lib/folders.ts` (`withoutFolders`, Leseprobe) lädt per `import()` erst, wenn eine untypisierte Datei geprüft werden muss; `transferFiles` liegt neu in `lib/transfer.ts` und bleibt statisch, weil ein `DataTransfer` nur synchron im Ereignis lesbar ist. Schlägt der Chunk fehl, gehen die Dateien ungeprüft weiter (ein Ordner scheitert dann sichtbar als Upload-Chip) | `pastes.test.tsx` wartet auf den Lazy-Inhalt (`expectChips`, `findBy…`), `mention.test.tsx` tat es schon; `attachments.test.tsx` (Ordner-Leseprobe jetzt über `import()`) unverändert grün; `lib/transfer.test.ts` + `lib/folders.test.ts` aufgeteilt; Sichtprüfung §3 (Vorladen beim Fokus, erste Paste, Tastatur); Messung §4 |
| V4-07 (NIT) Folgetext klebt an der letzten Paste-Zeile | `expandPastes`: endet ein Paste nicht mit `\n` und geht der Text in derselben Zeile weiter, wird ein `\n` eingefügt und der Leerraum (Leerzeichen/Tab) zwischen Token und Text entfällt; am Textende, vor einem Zeilenumbruch und nach einem Paste mit abschließendem `\n` nichts. Gilt für Prompt, Antwort und `getDraft` (Entscheidungsleiste) gleich | `lib/pastes.test.ts` (2 neue Fälle, 2 angepasste), `pastes.test.tsx` „V4-07: a question after the paste is not glued to its last line“ und der angepasste Sendetest. Gegenprobe: ohne Einfügen 7 Tests rot |
| R5W-09 Anteil Composer | `AttachmentChips` nutzt `formatFileSize` aus `@web/lib/bytes` (Paket K); `features/composer/lib/format.ts` gelöscht | `attachments.test.tsx` (184 kB, 2.4 MB, 10 MB, 20 MB unverändert grün) |
| R5W-11 Anteil Composer | neu `state/drafts.test.ts`: Wiederherstellen, kaputtes JSON (Text bleibt, Token als Text), falsche Form bzw. Paste ohne Token, werfender `localStorage`-Getter (leerer Entwurf, Änderungen im Speicher, nichts wirft), volles Storage (`setItem` wirft) | 5 Tests; der Code war schon defensiv (keine Gegenprobe sinnvoll) |

### Zurückgestellt

| Befund | Grund |
|---|---|
| Composer-Knöpfe bei reinen Hintergrund-Tasks | Koordinator §3 (erst WP-61) – nicht angefasst |
| V4-07 zweiter Teil (lange Nutzer-Nachricht einklappbar / Chip in der Blase) | Transkript (F2, optional) |
| R5W-08 (Zustand je Session aufräumen) | Koordinator §3 |
| Neuer 137-B-Start-Chunk `cn-*.js` (siehe §4) | Chunking-Entscheidung von Rolldown (`cn` wird jetzt von Start- und Lazy-Chunks geteilt); kein Eingriff in `vite.config.ts` (Root-Config, tabu). F6 bewertet ihn in der Bundle-Messung |

## 2. Entscheidungen

1. **Neutralisieren per U+200B statt Leerzeichen/Zeilenumbruch** (R5W-03): Der Server prüft Prompts
   selbst mit `trim()` (`titleFromPrompt`, `parseRenameCommand` – ein ` /rename …` aus einem Paste
   würde dort als Umbenennung gelten), ob die CLI trimmt, ist offen. U+200B ist kein Leerraum für
   `trim()`/`\s`, im Transkript unsichtbar und ändert keinen Paste-Text. Folge: Ein Session-Titel aus
   so einem Prompt beginnt mit dem unsichtbaren Zeichen (siehe Wünsche).
2. **Fuzzy-Güte composer-seitig**: `fuzzyFilter(…, { strict: true })` (vorhanden seit V3-03) plus
   Rang-Gruppen in `matchPaths`, statt `lib/fuzzy.ts` zu ändern. Kürzere Dateinamen gewinnen
   Gleichstände (Längenabzug von `fuzzyScore`): `composer` → `docs/composer.md` vor `Composer.tsx`.
3. **Lazy mit Vorladen beim ersten Fokus** (R5W-01) statt reinem Laden beim ersten Render: Die
   Chunks sind nicht mehr im Start-Chunk, die erste Paste bzw. das erste `@` finden sie aber geladen
   (kein Aufblitzen); jede Lazy-Stelle hat eine eigene `SlotBoundary`, weil `Composer` in `App.tsx`
   ohne Grenze eingehängt ist.

## 3. Sichtprüfung

Vite (`PARALLAX_DEV_WEB_PORT=5192`, `pnpm dev:web`), Playwright headless (`channel: 'chrome'`),
Playground `composer/mention` und `composer/pastes`, 1280×800 dark-en; danach Vite beendet
(`taskkill /T /F`).

- Vor dem Fokus kein Request auf `FileMentionMenu`/`PasteChips`, nach dem ersten Klick ins Feld beide.
- `schau dir @`, 2× ↓ (`…-mention-option-2`), `plan` tippen → aktiv `…-option-0`; Liste
  `plan.md` (docs), `2026-10 Planung.md`; Tab fügt `@docs/plan.md ` ein.
- „Paste a 120-line log“ → Token `[#1 · 120 lines]` und Chip „Pasted text #1 · 120 lines“ sofort;
  Abstand über dem Feld unverändert.
- Keine Konsolenfehler.

## 4. Bundle (R5W-01, `pnpm build`, gzip -9)

Methode: Start-Chunks = Entry + `modulepreload` aus `dist/web/index.html`; Zuordnung im `index`-Chunk
über die dekodierte Sourcemap.

| | vorher (`87def00`) | nachher | Δ |
|---|---|---|---|
| `index-*.js` raw / gzip | 442 830 / 128 779 | 440 906 / 128 688 | −1 924 / −91 |
| Summe Start-Chunks raw / gzip | 943 552 / 280 953 (5 Dateien) | 941 182 / 280 866 (6 Dateien, neu `cn-*.js` 137 / 142) | −2 370 / −87 |
| Composer-Quellen im `index` raw | 74 149 | 71 693 (73 212 laut Sourcemap, davon 1 519 Vite-Preload-Helfer, vorher einem anderen Modul zugeordnet) | −2 456 |

- Aus dem Start-Chunk: `FileMentionMenu.tsx` 1 944, `PasteChips.tsx` 1 886, `lib/folders.ts`
  571 → 329 (`lib/transfer.ts` bleibt), `lib/format.ts` 224 (jetzt `@web/lib/bytes`).
- Neu im Start-Chunk durch die Fixes: `lib/mentions.ts` +587 (V4-03), `lib/pastes.ts` +369 (V4-07,
  R5W-03), `Composer.tsx` +897 (Lazy-Hüllen, Vorladen, Grenzen, V4-03).
- Lazy-Chunks: `FileMentionMenu-*.js` 2 174 / 960, `PasteChips-*.js` 2 778 / 1 384, `folders-*.js`
  312 / 245 (raw / gzip; enthalten auch die nur dort genutzten Icons – `vendor` −565 B raw).

## 5. Checks

- `pnpm exec tsc -b`: grün. `pnpm exec eslint src/web/features/composer --max-warnings=0`: grün.
  `prettier --check src/web/features/composer`: grün.
- `pnpm exec vitest run src/web/features/composer`: 17 Dateien, 207 Tests grün (vorher 16/190).
- `pnpm check` (einmal am Ende, Hintergrund, parallel zu F1/F2/F4/F5): typecheck, lint grün; Vitest
  280 Dateien, 4 773 Tests grün – kein Last-Flake, nichts nachgelaufen.
- `pnpm build`: grün (Werte §4 aus diesem Lauf).
- Ein Zwischenbuild vor den letzten Kommentar-/Doku-Änderungen ergab 11 B gzip weniger im `index`
  (raw gleich; vermutlich die eingebettete Build-Kennung).

## 6. Live-Prüfpunkte für WP-61

1. **R5W-03:** großen Text mit `/clear …` (bzw. `/c/Users/…`-Log) am Feldanfang einfügen, etwas
   dahinter tippen, senden → die CLI antwortet als Modell (kein Befehl, keine
   „Unknown command“-Meldung); Nutzer-Blase zeigt den Text ohne sichtbares Zeichen davor; Titel der
   Session prüfen (beginnt mit U+200B).
2. **V4-07:** Paste + „was ist kaputt?“ → Frage steht in der Blase und bei Claude in einer eigenen
   Zeile.
3. **V4-03:** @-Picker in einem großen Repository (≥ 10 000 Dateien): Antwortzeit beim Tippen mit
   der strikten Bewertung und den Rang-Gruppen (Fuzzy läuft jetzt zweimal: Name+Pfad, nur Name);
   Reihenfolge bei typischen Suchen (Dateiname, Ordner/Datei, Abkürzung).
4. **R5W-01:** erstes `@` und erste Paste direkt nach dem Start (Chunk über das Netz des echten
   Servers): kein Aufblitzen; Ordner aus dem Explorer auf die Pane ziehen (Leseprobe jetzt als
   Lazy-Chunk).

## 7. Wünsche an den Koordinator

- **Server (F1/Folgepaket, optional):** `titleFromPrompt` (`src/server/sessions/summary.ts`) könnte
  ein führendes U+200B (`SLASH_GUARD`) vor dem Titel entfernen; inhaltlich unschädlich.
- **F6:** E2E-Fälle V4-03 und R5W-03 wie geplant; der Prompt beginnt mit U+200B – der E2E sollte
  `startsWith('/')` auf dem gesendeten Text verneinen bzw. `​/…` erwarten.
- Keine neuen Abhängigkeiten, keine Contract-Änderung.
