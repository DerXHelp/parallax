# FIX-R5-F5 – Shell/i18n/App (Ergebnis)

> Fix-Runde nach R5/R5-web/V4 (Phase 3), Paket **F5** laut `docs/wp/FIX-R5.md` §2. Worktree
> `.worktrees/fix-r5-f5`, Branch `fix/r5-f5`, Basis `feature/phase-3` = `87def00`. Besitz-Pfade:
> `src/web/shell/**`, `src/web/state/**`, `src/web/i18n/**`, `src/web/features/preferences/**`,
> `src/web/lib/**` (ohne `file-refs.ts`, `bytes.ts`), `src/web/{App,main}.tsx`, `src/web/App*.test.tsx`,
> `src/web/playground/**`, dieses Dokument. Verbindlich: ADR-153. Kein Live-`claude`; Sichtprüfung nur
> per Playwright headless gegen `pnpm dev:web` (Port 5194).

## 1. Befunde

### Behoben

| Befund | Umsetzung | Test (Gegenprobe) |
|---|---|---|
| **R5W-01** Start-Chunk: `de`-Wörterbücher (ADR-153) | **Registrierung:** `i18n/dictionaries.ts` hält `EN_DICTIONARY` (alle en-Namensräume, statisch) und lädt jede andere Sprache über `import('./dictionary.de')`. `i18n/dictionary.de.ts` fasst alle 13 deutschen Wörterbücher (Shell, `errors`, alle Features und Shell-Bereiche) in **einem** Lazy-Chunk zusammen (Typ `Dictionary` = Typ von `EN_DICTIONARY`, fehlende Schlüssel bleiben Compile-Fehler). `loadDictionary` memoisiert die laufende Anfrage, merkt sich keine Fehler (der nächste Aufruf versucht es neu). **Umschalten:** `i18n/language.ts` – `createLanguageController(source, onApply)`: `setLanguage` schaltet sofort, wenn das Wörterbuch da ist, sonst erst nach dem Laden; die letzte Anfrage gewinnt (`en` → `de` → `en` schnell hintereinander bleibt Englisch). Ein Ladefehler lässt Englisch stehen; `getLanguageLoadFailure`/`useLanguageLoadFailure` liefern den **ersten** Fehler des Fensters. `translate` fällt bis zum Laden auf Englisch zurück. **Hinweis:** `ShellEffects` zeigt beim Fehler genau einen Hinweis (feste ID `shell-language-load`, Ton `warning`, 15 s, Knopf „Reload“ → `reloadWindow`). **Vorladen:** `state/language.ts` merkt eine Nicht-Standard-Sprache in `localStorage` `parallax.language` (`STORAGE_KEYS.language`; Englisch = kein Schlüssel, ein rein englisches Fenster schreibt nichts) und `main.tsx` lädt beim Start den Chunk der zuletzt genutzten Sprache vor (`preloadInitialLanguage`, schaltet nicht um – Start bleibt Englisch). **Kein zusätzliches Aufblitzen:** wie bisher ist das Fenster Englisch, bis `host.state` die Einstellung bringt; war Deutsch zuletzt aktiv, ist der Chunk dann in aller Regel schon da (Vorladen ab `main.tsx`, lokaler Server). Nur beim allerersten Wechsel auf Deutsch kommt die Ladezeit des Chunks (≈ 21 kB gzip, lokal) hinzu – nach einem Klick, nicht beim Start. **Testmodus:** `dictionaries.ts` lädt `de` im Vitest-Modus per Top-Level-Await vorab (`if (import.meta.env.MODE === 'test') await loadDictionary('de')`), damit fremde Tests weiter synchron `setLanguage('de')` aufrufen; im Build wird der Zweig weggefaltet (kein `await` im Output, Hashes mit und ohne die Zeile identisch). `BoundFormat`/`format.ts` bekamen `list`/`formatList` (für R5W-06) | `i18n/bundle.test.ts` (3): statischer Importgraph ab `main.tsx` über die Quellen (`import.meta.glob` `?raw`, `import type` ausgenommen) erreicht `App.tsx` und alle en-Wörterbücher, aber **keine** deutsche Datei; alle `de`-Dateien (> 10) liegen im Graphen von `dictionary.de.ts`; der i18n-Kern importiert nichts außerhalb von `/i18n/` (siehe §2.2). Gegenprobe: gegen das alte `i18n/index.ts` (statische `de`-Importe) → 2 rot. `i18n/i18n.test.tsx`: Schlüssel-Abgleich en/de bleibt **statisch** (`EN_DICTIONARY` gegen `deDictionary`), dazu „jeder Namensraum in beiden Sprachen registriert“, Controller: wartet aufs Laden und meldet einmal, letzte Anfrage gewinnt, Ladefehler → Englisch + genau eine Meldung, zweiter Versuch ohne zweite Meldung, App-Controller schaltet synchron. `state/language.test.tsx` (4): merkt `de`, entfernt bei `en`; rein englisches Fenster schreibt nichts (mit Positivkontrolle); nur bekannte Sprachen, werfender Storage = keine; Start lädt vor, nie `en`, schaltet nicht um. `shell/ShellEffects.test.tsx` (2): keine Meldung ohne Fehler; genau **eine** Meldung unter StrictMode, „Reload“ lädt neu. Gegenprobe: ohne `useLanguageLoadNotice` → rot. Playwright (§4) |
| **R5W-02** Chunk-Fehler: eine Fehlerkarte je Inline-Verweis | `shell/SlotBoundary.tsx`: optionaler Render-Prop `fallback(failure: { chunk })` ersetzt die Karte (leise Variante); `withSlotBoundary(Slot, resetKeyOf?, fallbackOf?)`. Die leise Variante meldet **einmal je Fenster** einen Hinweis mit fester ID `shell-slot-quiet-failure`: Chunk-Fehler → `navigation.slotError.inlineChunk` (Ton `error` = `role="alert"`, bleibt stehen, Knopf „Reload window“), Renderfehler → `inlineRender` (Ton `error`, ohne Knopf). Ein neuer Reset-Key (anderer Pfad) gibt einen frischen Versuch. `App.tsx`: `FileLink` = `bounded(FILES_SLOTS.FileLink, (p) => p.path, fileLinkFallback)`; der Fallback zeigt den Kindertext bzw. `defaultFileLinkLabel(path, line)` als `PlainReference` (`state="checking"`, ohne Tooltip) in einem `span data-slot="file-link-fallback" data-error-kind` – inline, also kein `div` in `p`; die Menü-Variante (`variant: 'menu'`) fällt ersatzlos weg (`null`). Die übrigen Slots behalten die Karte | `App.slots.test.tsx` „20 references …“: 20 Verweise + einer mit Kindertext in einem `p` plus Menü-Variante, Chunk-Fehler → 21 Fallbacks mit `src\file0.ts:12`, `src\file1.ts`, „the README“, keine Karte, kein `div` im `p`, **genau ein** `role="alert"`, Notice-IDs = `[shell-slot-quiet-failure]`. Gegenprobe: ohne `fileLinkFallback` → rot. `SlotBoundary.test.tsx` (+3): 20 Inline-Slots in einem `p` → Text, keine Karte, eine Notice `inlineRender` ohne Knopf; Chunk-Fehler → `inlineChunk`, `durationMs: null`, Knopf lädt neu, nach dem Verwerfen keine zweite Meldung; neuer Reset-Key → frischer Versuch. Playground-Demo `shell-slot-quiet` |
| **R5W-06** Anteil (literale Trenner) | `shell/header-panels.tsx`: `PANEL_COUNTER_MAX = 99`, Anzeige über `t('navigation.panels.countOverflow', { max })` (`'{max}+'`); der Knopfname nennt die genaue Zahl. `preferences/sections/FilesSection.tsx`: `format.list(DEFAULT_PROGRAM_EXTENSIONS)` (`Intl.ListFormat`, Konjunktion) statt `join(', ')` | `header-panels.test.tsx`: 120 Tasks → „99+“, Name mit 120. `FilesSection.test.tsx`: Liste endet auf „, and …)“. `i18n.test.tsx`: `formatList` en „txt, md, and pdf“, de „txt, md und pdf“ |
| **R5W-10** Anteil (`openFolderInExplorer`) | `shell/navigation/session-actions.tsx`: ein `cwd`, das `windowsPathIssue` ablehnt (UNC, Gerät, ADS), wird nie gesendet – Hinweis `PATH_REJECTED` an der Session (wie `files/lib/actions.ts`) | `open-folder.test.tsx` „a cwd the path rules reject is never sent …“ (UNC-`cwd`): Hinweis „This path cannot be used …“, kein `file.open` in `host.commands`. Gegenprobe: ohne Filter → rot (erste Fassung prüfte `fileOpens`, das abgelehnte Befehle nicht aufzeichnet – falsch grün, korrigiert) |
| **R5W-11** Anteil (Testlücken) | (1) `SidePanelHost.test.tsx` Overlay-Fall drückt wirklich Tab: vom letzten Bedienelement verlässt Tab das Panel, vom ersten Shift+Tab. (2) `open-folder.test.tsx`: `PATH_NOT_ALLOWED` → „Access to this path is not allowed.“ (3) Polling nur bei sichtbarem Tab direkt: Stub-Viewer mit `setInterval` (Fake-Timer nur für `setInterval`/`clearInterval`) – 3 Ticks auf dem Datei-Tab, Tab „Aufgaben“ → keine weiteren, zurück → 4, Panel zu → bleibt 4 | die genannten Fälle grün |
| Optional: Playground | `playground/demos.tsx` registriert `shellPhase3Demos` direkt (nach den Navigations-Demos); der Preferences-Playground hängt sie nicht mehr an. Neue Demo `shell-slot-quiet` (6 leise Grenzen in einem `p`) | `playground/playground.test.tsx`: alle 9 Phase-3-Shell-IDs gelistet, die Demos rendern (leise Variante ohne `div` im `p`); `preferences/playground.test.tsx` ohne Shell-IDs |
| Koordinator-Hinweis: Storage-Spies (F4) | `vi.spyOn(Storage.prototype, …)` greift in happy-dom nicht, sobald die Methode einmal benutzt wurde. Betroffen: `SidePanelHost.test.tsx` („broken storage“), `SidebarFrame.test.tsx` (`readSidebarCollapsed` mit kaputtem Storage; „broken localStorage …“). **Alle drei waren falsch grün.** Ein Spy auf die Instanz (`window.localStorage`) greift zwar, wird aber von `vi.restoreAllMocks()` nicht zurückgesetzt (happy-dom-Storage ist ein Proxy) und leckte in die Folgetests (4 rot). Umgestellt auf einen Spy auf den **Getter** `window.localStorage`/`sessionStorage`, der ein eigenes Storage-Objekt liefert (`brokenStorage(attempts)`: Lesen/Schreiben werfen und werden protokolliert); `SidePanelHost` setzt jetzt erst die Mocks zurück und leert dann den Storage. `state/language.test.tsx` nutzt dasselbe Muster (protokollierender Storage statt Instanz-Spies) | Je Fall eine Kontrolle, die nur ein funktionierender Storage liefern würde (gemerkte Breite 900, gemerktes „eingeklappt“ in beiden Bereichen bzw. in `localStorage`), dazu die protokollierten Zugriffe. Gegenprobe mit den alten Prototyp-Spies: alle 3 rot („900“ statt „630“, `true` statt `false`, „collapsed“ statt „expanded“) |

### Zurückgestellt

Aus dem F5-Anteil nichts. Nicht im F5-Anteil (andere Pakete laut `FIX-R5.md` §2): R5W-01 Hebel 2–4
(`todoProgress`, `FileMentionMenu`, `PasteChips` – F2/F3), R5W-06 `FileLink`/`TasksPanel`/`TaskStrip`,
R5W-10 `stat-cache`/`file-document`/`CodeView`, R5W-11 übrige Lücken und Wartezeiten.

## 2. Entscheidungen

1. **Top-Level-Await nur im Testmodus:** Die Alternative – alle Tests mit `await setLanguage('de')`
   – hätte Dutzende fremde Testdateien (Features, Tabu) berührt. Der Zweig hängt an
   `import.meta.env.MODE === 'test'` und verschwindet im Build (geprüft).
2. **Merken/Vorladen in `state/language.ts`, nicht in `i18n`:** Ein Import von `@web/lib/storage` in
   `i18n/language.ts` ließ Rolldown den ganzen i18n-Kern samt en-Wörterbüchern in einen eigenen
   Start-Chunk `i18n-*.js` (62 kB) legen (Proben: ohne Top-Level-Await, ohne `import()`, ohne
   Vorladen jeweils unverändert; ohne den Import weg). Der i18n-Kern importiert deshalb keine
   App-Module; `bundle.test.ts` wacht darüber.
3. **Leise Slot-Fehler laut genug:** Der eine Hinweis je Fenster hat den Ton `error` (einziger
   `role="alert"`), beim Chunk-Fehler ohne Ablauf und mit „Reload window“ – der Nutzer erfährt, warum
   Links zu Text wurden. Der Sprach-Hinweis ist `warning` (die App bleibt voll bedienbar). Fallback
   = `PlainReference` mit `state="checking"`: dieselbe Darstellung wie ein noch ungeprüfter Verweis,
   kein neuer Zustand im Feature (Tabu-Pfad).

## 3. Bundle (Start-Chunk)

`vite build`, Größen der Dateien aus `dist/web/index.html` (Entry + `modulepreload`), gzip Stufe 9 per
Node-zlib (`measure.mjs`, Scratchpad).

| Stand | `index` raw | `index` gzip | Start gesamt raw | Start gesamt gzip |
|---|---|---|---|---|
| vorher (`87def00`) | 442 830 | 128 779 | 943 552 (5 Dateien) | 280 953 |
| nachher | 383 677 | 112 060 | 884 399 (5 Dateien) | 264 234 |
| Differenz | **−59 153** | **−16 719** | −59 153 | −16 719 |

Lazy `dictionary.de-*.js`: 62 544 raw / 21 253 gzip (alle 13 deutschen Namensräume). Zum Vergleich
`109c073` (WP-60-Basis, gleiche Messmethode): `index` 383 072 / 110 409 – der Phase-3-Zuwachs bis
`87def00` (+59,8 kB raw) ist damit fast vollständig ausgeglichen. Die Werte in `WP-60.md` §2.5 stammen
vermutlich aus einem anderen gzip-Verfahren; Vergleiche nur innerhalb einer Methode.

## 4. Checks

- `pnpm exec tsc -b`: grün. `pnpm exec eslint <geänderte Dateien> --max-warnings=0`: grün.
  `prettier --check`: grün.
- `pnpm exec vitest run src/web/shell src/web/state src/web/i18n src/web/features/preferences
  src/web/lib src/web/App.test.tsx src/web/App.slots.test.tsx src/web/playground`: 68 Dateien,
  629 Tests grün.
- `pnpm check` (einmal, Hintergrund): typecheck, lint, test grün – **281 Dateien, 4778 Tests**, keine
  Flakes (die bekannten Last-Kandidaten liefen mit). `pnpm build`: grün; Messung am Build-Output
  bestätigt die Werte aus §3 (`index-Dtg2GRcR.js` 383 677 / 112 060).
- **Playwright headless** (Chrome, `pnpm dev:web` auf 5194, `#playground=shell-overview`): vor dem
  Umschalten `lang=en`, 0 Anfragen an deutsche Wörterbücher; Klick auf „Deutsch“ → `lang=de`,
  14 deutsche Module geladen (`dictionary.de.ts` + 13), deutscher Text sichtbar,
  `parallax.language=de` gemerkt; nach Reload `lang=en` (Start bleibt Englisch), die 14 Module als
  Vorladen geholt; keine Seitenfehler. Vite danach beendet (`taskkill /T /F`).

## 5. Live-Prüfpunkte für WP-61

1. **Chunk-Fehler nach einem Neubau** (R5W-02; nur Dev-Instanz mit eigenem `PARALLAX_HOME`): Fenster
   offen lassen, neu bauen, dann ein Transkript mit vielen Pfad-Verweisen öffnen → Verweise als Text,
   **ein** Hinweis „A part of the app could not be downloaded …“ mit „Reload window“, keine Karten im
   Fließtext; nach dem Neuladen wieder Links.
2. **Sprachwechsel im Build** (R5W-01): auf Deutsch umschalten → Umschalten ohne sichtbare
   Verzögerung, kein halbdeutsches Fenster; Fenster neu laden bzw. Parallax neu starten → kurz
   Englisch wie bisher, dann Deutsch ohne zusätzliches Aufblitzen (Vorladen). DevTools: der Chunk
   `dictionary.de-*.js` erscheint erst nach dem ersten Wechsel bzw. beim Start nach einem
   deutschen Lauf.
3. **Ladefehler der Sprache:** im Build den Chunk `dictionary.de-*.js` umbenennen, auf Deutsch
   umschalten → bleibt Englisch, genau ein Hinweis mit „Reload“.

## 6. Wünsche an den Koordinator

- `src/web/shell/README.md` (mehrere Owner): Zeile `phase3-demos.tsx` – „gelistet vom
  Preferences-Playground“ → „registriert in `src/web/playground/demos.tsx`“, neue Demo
  `shell-slot-quiet`; Zeile `SlotBoundary.tsx` – optionaler `fallback` (leise Variante, ein Hinweis je
  Fenster, `QUIET_SLOT_NOTICE_ID`, `resetQuietSlotFailures`, `reloadWindow`); Zeile `ShellEffects.tsx` –
  Sprache über `state/language.ts`, Hinweis bei Ladefehler; Zeile `header-panels.tsx` – Zähler „99+“
  über `PANEL_COUNTER_MAX`.
- `src/web/lib/README.md` (mehrere Owner): Zeile `storage.ts` – neuer Schlüssel
  `STORAGE_KEYS.language` (`parallax.language`).
- `src/web/README.md:13` (optional): Zeile `i18n/` stimmt weiter; ergänzen „`de` als Lazy-Chunk
  (ADR-153)“.
- READMEs fremder Features nennen noch „registriert in `src/web/i18n/index.ts`“:
  `features/files/README.md:28`, `features/tasks/README.md:28`, `features/profiles/README.md:20` →
  `i18n/dictionaries.ts` bzw. `dictionary.de.ts`. (Die Shell-Unterordner `navigation`, `side-panel`,
  `server-shutdown`, `new-session` sind in diesem Paket nachgezogen.)
- Neue Namensräume künftig in **beiden** Dateien registrieren (`dictionaries.ts` und
  `dictionary.de.ts`); `bundle.test.ts` und der Schlüssel-Abgleich in `i18n.test.tsx` fangen Lücken.
- Test-Muster „kaputter Storage“ in happy-dom (für F4 und künftige Tests): Spy auf den Getter
  `window.localStorage`/`sessionStorage` mit eigenem Storage-Objekt – weder `Storage.prototype` noch
  die Instanz.
