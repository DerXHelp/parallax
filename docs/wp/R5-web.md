# R5-web – Review Phase 3 „Dateien & Plan-Komfort“, Teil Web

> Phase 3, Welle 3b (parallel zu R5 und V4, nach dem Merge von WP-60). Read-only im eigenen Worktree
> `.worktrees/r5-web` (Branch `wp/r5-web`), Stand `feature/phase-3`. Kein Live-`claude`.

## 1. Auftrag

### Ziel
Die Web-Seite von Phase 3 (WP-50 Teil 2 Gerüst, WP-54 … WP-58, WP-60 Web) auf Korrektheit,
Konventionen, Barrierefreiheit, Sicherheit und Speicher prüfen und Befunde mit Schwere melden:
**[BLOCKER vor WP-61]**, **[SOLLTE]**, **[NIT]**. Nichts beheben.

### Pflichtlektüre
`CLAUDE.md`; `docs/wp/WP-50.md` §2, §3, §4.5–4.8, §4.14 C, §5 (ADR-142, -143, -145, -146, -148, -150,
-151), §6, §9; „2. Ergebnis“ von WP-54 … WP-58 und WP-60; `docs/architecture.md` §2.3; ADR-126;
`docs/wp/R4-web.md` (Aufbau).

### Prüfschwerpunkte
1. **Grenzen:** Features importieren einander nie (Slots, Anfragen), Shell importiert keine Features,
   ESLint-Gruppen `files`/`tasks`, reine Helfer nur in `web/lib`, UI-Primitives nur aus `web/ui`.
2. **Sicherheit:** kein `dangerouslySetInnerHTML`/`rehype-raw`; Links nur http(s) oder `FileLink`;
   UNC/Device nie an den Server (Stringfilter im Client); `iframe`/`img` nur auf `/api/file` bzw.
   `/api/blob`; Teil-JSON-Parser robust; Pastes/@-Picker ohne Injektion in Slash-Befehle.
3. **i18n:** keine Literale (auch `title`, `aria-label`, `placeholder`), Namensräume je Paket,
   en/de vollständig, Fehler über `tError`.
4. **A11y/Tastatur:** Tabs, Splitter (`role="separator"`), Überlagerungen (Esc, Fokus-Rückgabe),
   @-Picker (`aria-activedescendant`), Kopfzeilen-Knöpfe (`aria-pressed`), Task-Stop mit Rückfrage.
5. **Speicher/Leistung:** Stat-Cache (TTL, LRU), Polling nur sichtbar, virtualisierte Listen und
   Code-Ansicht, Shiki-Grenze, große Pastes in Entwürfen, Bundle (lazy Chunks, Start-Chunk-Budget aus
   WP-60).
6. **Verhalten:** Live-Refresh, Plan-Live-Vorschau → Datei, Diff, Split-Button-Gedächtnis (Bypass nie),
   Drop-Zone vs. Drop-Schutz, schmales Fenster, `SlotBoundary`, Remote-Host ohne Editor/Explorer.
7. **Tests:** Abdeckung der normativen Punkte je Auftrag, keine festen Wartezeiten, `localStorage`-
   Fehlerfälle.

### Vorgehen
`git diff 109c073..feature/phase-3` für `src/web/**`; Schwerpunkt-Dateien vollständig lesen; gezielte
Vitest-Läufe; Playground nur über Playwright (eigener Vite-Port `$env:PARALLAX_DEV_WEB_PORT='5189'`,
keine Desktop-Bedienung), danach Vite beenden. Kein `pnpm check`/`pnpm e2e` (V4 läuft parallel).

### Ergebnis
Diese Datei ab „2. Ergebnis“: Vorgehen, Gesamturteil, Befunde (ID `R5W-nn`, Schwere, Ort, Beleg,
Vorschlag), „Hinweise für WP-61“.

### Live-`claude`
Nein.

### Commit und Bericht
Nur `docs/wp/R5-web.md` ändern; lokal auf `wp/r5-web` committen (Deutsch, mehrere `-m`, kein
Heredoc), nie pushen. Bericht im CLAUDE.md-Format (≤ 250 Wörter) mit Zählung BLOCKER/SOLLTE/NIT.
Textdateien nur mit Edit/Write-Werkzeugen ändern (Umlaute).

## 2. Ergebnis

> Stand `feature/phase-3` @ `52af898` (WP-50 … 58 und WP-60 gemergt), Worktree `.worktrees/r5-web`,
> 12.11.2026. Rolle: Reviewer Web, read-only (nichts behoben). Umfang: `git diff 109c073..52af898 --
> src/web` (141 geänderte oder neue Produktivdateien ohne Tests, Playground und Demos) plus
> Bundle-Vergleich des Start-Chunks.

### Vorgehen und Checks
- Diff `109c073..feature/phase-3` für `src/web/**`. Vollständig gelesen:
  - `features/files/**` (`FileLink`, `stat-cache`, `actions`, `FilePanel`, `file-document`,
    `file-source`, `CodeView`, `ImageView`, `PdfView`, `FilesPanel`, `session-files`, `file-tools`,
    `format`, `index`);
  - `shell/side-panel/**`, `ui/splitter.tsx`;
  - `shell/{SlotBoundary,SessionPane,header-panels,session-drop,drop-guard,SidebarFrame,sidebar-layout}`,
    `shell/navigation/session-actions.tsx`, `App.tsx`;
  - `lib/file-refs.ts`, `lib/safe-url.ts`, `transcript/markdown/{rehype-file-refs,FileReference,MarkdownRenderer}`,
    `transcript/components/ToolFileLink.tsx`, `transcript/items/AgentCard.tsx`, der Diff von
    `TranscriptView.tsx`;
  - `features/tasks/**`;
  - aus `features/decisions`: `PlanPanel`, `plan-parts`, `PlanDiff`, `PlanSidePanel`, `bar-store`,
    `plan-data`, `partial-json`, `plan-file`, `plan-versions`;
  - aus `features/composer`: `Composer`, `FileMentionMenu`, `PasteChips`, `attachments`, `drafts`,
    `pastes`, `mentions`, `project-files`, `upload`, `folders`, `slash`;
  - `features/preferences/{sections/FilesSection,lib/editor}`;
  - `eslint.config.js` (Feature-Gruppen).
- Greps auf:
  - Cross-Feature-Importe;
  - `dangerouslySetInnerHTML`, `rehype-raw`, `innerHTML`;
  - `iframe` und `img`;
  - literale `title`, `aria-label` und `placeholder` sowie Trenner.
- i18n-Skript (Scratchpad, Node 26 mit Type-Stripping): 13 Wörterbuchpaare, 1346 Schlüssel.
  - Die Platzhalter `{…}` sind in en und de überall identisch.
  - Es fehlen keine Schlüssel und es gibt keine überzähligen; die Schlüsselgleichheit prüft zusätzlich
    `i18n.test.tsx`.
- Bundle:
  - Gebaut mit `vite build`: `109c073` (per `git archive` in den Scratchpad) und der aktuelle Stand.
  - Die Bytes des Start-Chunks `index-*.js` sind über die Sourcemap (VLQ-Dekodierung der Mappings)
    je Quellmodul zugeordnet.
  - gzip mit Stufe 9.
- ReDoS-Messung von `lib/file-refs.ts` (Node, synthetische Eingaben).
- Playground headless (Playwright 1.64, `channel: 'chrome'`, Vite auf Port 5189):
  - Alle 111 Demos bei 1400 und 820 px angeklickt; Konsole (`error`/`warning`) und `pageerror`
    gesammelt.
  - Vite danach per `taskkill /PID … /T /F` beendet; der Port ist wieder frei.
- Gezielte Vitest-Läufe (kein `pnpm check`, kein `pnpm e2e`):
  - (a) Testprüfung durch einen Hilfs-Subagenten (Tests nur gelesen, eigene Läufe) über
    `features/files`, `shell/side-panel`, `features/tasks`, `features/composer`, `session-drop` und
    `SlotBoundary`. Lauf 1: 305/306 (Timeout in `FilePanel.test.tsx:132`); Lauf 2: 306/306.
  - (b) Eigener Lauf über `features/decisions`, `features/transcript`, `lib/file-refs.test.ts`,
    `features/preferences`, `shell/header-panels`, `shell/SidebarFrame`, `shell/navigation`, `i18n`
    und `playground`: 521/522 (Flake `DecisionBar.test.tsx:245`). Die Datei danach allein 3× 13/13.
- Kein Live-`claude`, keine Desktop-Bedienung.

### Gesamturteil
Die Web-Seite von Phase 3 ist sauber geschnitten und für WP-61 tragfähig:
**0 BLOCKER, 4 SOLLTE, 7 NIT.**

Diese Bereiche halten:
- Grenzen;
- Sicherheit (Links, UNC-/Device-Filter, `iframe`/`img`-Quellen, Teil-JSON);
- A11y der neuen Bausteine;
- Vollständigkeit der Übersetzungen.

Vor dem Merge nach `main` zu beheben:
- das Start-Chunk-Budget (R5W-01; die Module sind unten einzeln genannt);
- die Fehlerkarte je Inline-Verweis bei Chunk-Fehlern (R5W-02);
- die Slash-Erkennung, die vor dem Einsetzen der Paste-Chips läuft (R5W-03);
- drei reale bzw. latente Test-Flakes (R5W-04).

### Abgleich mit den bekannten Follow-ups (`docs/progress.md`, Phase 3)
- **Bundle-Budget (WP-60): bestätigt und präzisiert** → R5W-01.
  - Eigene Messung `index`: +59 665 B raw / +18 341 B gzip – deckt sich mit WP-60.
  - Als Summe aller Start-Chunks: +63,5 kB raw / +19,6 kB gzip. Darin enthalten: `vendor` +2,2 kB
    (nur durch neue lucide-Icons) und `button-*.js` mit 1 597 B (per modulepreload geladen).
- **`stopTask` doppelt** (`transcript/state/tasks.ts` ↔ `tasks/state/tasks.ts`): bestätigt, nicht
  erneut gemeldet.
- **Eigener `/api/file`-Leser** (`decisions/state/plan-data.ts` ↔ `files/state/file-source.ts`):
  bestätigt; in R5W-09 bei den anderen Dubletten genannt.
- **`FilePanel.test.tsx` (PDF) über 5 s: präzisiert** → R5W-04. Auch der Bild-Test (:132) lief in
  einen Timeout. Die Datei setzt kein `testTimeout`, das Web-Projekt hat 5 s.
- Composer-Stop ohne Turn und nicht verlinkte nackte Dateinamen: nicht erneut geprüft.

### Geprüft ohne Befund (Auszug)
- **Grenzen:**
  - ESLint-Gruppen `files`/`tasks` sind korrekt.
  - Keine Cross-Feature-Importe; `decisions`↔`composer` ist eine erlaubte Gruppe.
  - Die Shell importiert keine Features; UI-Primitives kommen nur aus `web/ui`.
- **Sicherheit:**
  - Kein `dangerouslySetInnerHTML`, `rehype-raw` oder `innerHTML`.
  - Markdown-Links nur http(s) (`safe-url`). Lokale Ziele werden zum `FileLink`, nie zu `<a href>`.
  - Der Stringfilter `windowsPathIssue` greift in `FileLink` (→ `PlainReference`), im Stat-Cache, in
    den Aktionen, in `file-refs` (`unsafe`) und in `plan-file.ts`.
  - `iframe`/`img` laden nur `fileUrl(…)`, `/api/blob` oder lokale `blob:`-Vorschauen.
  - Fetches laufen `same-origin`; Fehler werden per `errorPayloadSchema` gelesen.
  - Der Teil-JSON-Parser (`partial-json.ts`) wirft nie und lässt abgeschnittene Escapes und
    Surrogate weg. Schlüssel innerhalb fremder Strings werden nicht als Treffer gewertet.
- **i18n:**
  - Platzhalter in en/de identisch (Skript).
  - `tError` für alle Fehler-Payloads.
  - Keine literalen `title`, `aria-label` oder `placeholder` in neuen Dateien (Trenner: R5W-06).
- **A11y:**
  - Tabs über Radix.
  - Splitter mit `role="separator"`, `aria-valuenow/min/max/text`, Pfeiltasten, Home und End.
  - Panel: Esc mit Scope, Fokus-Rückgabe an den Öffner.
  - @-Picker: `aria-activedescendant`/`aria-controls` am Textfeld, Hinweise mit `role="status"`.
  - Kopfzeilen-Knöpfe mit `aria-pressed`; die Zähler sind `aria-hidden`, die Zahl steht im Label.
  - „Alle stoppen“ mit Inline-Rückfrage, der Fokus liegt auf „Abbrechen“.
- **Speicher/Leistung:**
  - Stat-Cache: 50-ms-Batch, TTL 30 s, LRU 2000, Retry nach 5 s.
  - Polling nur bei sichtbarer Seite und montiertem Tab.
  - `VList` in Dateien-Panel, Code-Ansicht und Transkript.
  - Shiki nur bis `HIGHLIGHT_MAX_CHARS`.
  - Plan-Texte in `SizedLru` (60 Einträge / 4 Mi Zeichen).
  - `fileToolIndex` und `planFileActivity` sind je `items`-Array gecacht.
  - `PlanDiff` und `PlanPanel` sind eigene Chunks.
- **Verhalten:**
  - Der Split-Button merkt sich Modus und frischen Kontext, Bypass nie (`writeApproveMode` und
    `rememberChoice`).
  - Plan-Live-Vorschau aus `inputPartial`, danach `GET /api/file` je Schreib-Stempel; als Fallback
    der Text der Entscheidung.
  - Die Drop-Zone ignoriert Drops mit `defaultPrevented` (Composer-Drop) und zeigt einen Hinweis,
    wenn niemand die Dateien annimmt.
  - Schmales Fenster: unter 900 px Leiste bzw. Overlay, unter 560 px kompakte Kopfzeile.
  - Remote-Host ohne Editor und Explorer: der Klick fällt auf den Viewer zurück.
  - `SlotBoundary` legt im Normalfall kein Wrapper-Element an.
- **virtua-Fix in `TranscriptView.tsx` (WP-55):** plausibel – eigenes `scrollTop` statt
  `scrollToIndex`, Wieder-Andocken in `onResize`. In Chrome deckt ihn `e2e/transcript.spec.ts:93ff.`
  ab (Mausrad nach oben beim Streamen, die Position bleibt); der Test lief in WP-60 grün.
- **Playground:** 111 Demos × 2 Breiten ohne Konsolenfehler. Einzige Meldungen sind die gewollten
  Fehler der Demo `shell-slot-error` (Render- und Chunk-Fehler).

### Befunde

#### R5W-01 [SOLLTE] Start-Chunk über Budget – Ursachen je Modul
- **Fundstelle:** `dist/web/assets/index-*.js` (Start-Chunk), Vergleich `109c073` ↔ `52af898`.
- **Beleg:** `index` wächst von 383 072 auf 442 737 B raw (+59 665) und von 110 409 auf 128 750 B
  gzip (+18 341); das Budget ist ≤ 10 kB.

  Netto-Zuwachs nach Quelle (raw, laut Sourcemap):

  | Quelle | Zuwachs (B raw) |
  |---|---|
  | `composer` | +16 103 |
  | `shell` | +10 855 |
  | `tasks` | +6 064 |
  | `shared` | +6 036 |
  | `files` | +4 834 |
  | `decisions` | +4 439 |
  | `preferences` (nur Wörterbücher) | +3 665 |
  | `side-panel` | +2 870 |
  | `navigation` | +2 454 |
  | `i18n` (errors) | +1 686 |
  | `transcript` | +537 |
  | `ui` (`button` ist jetzt ein eigener Chunk) | −1 375 |

  Statisch im `index`, aber **lazy-fähig:**

  | Modul | B raw | Weg |
  |---|---|---|
  | alle `de`-Wörterbücher (Phase-3-Anteil 10 941 B; inkl. `errors.de` mit 6 827 B) | 61 812 | nur die aktive Sprache statisch, `de` per `import()` laden |
  | `features/tasks/lib/rows.ts` (über `tasks/index.ts` → `todoProgress`) | 2 909 | `todoProgress` in ein eigenes kleines Modul; `rows.ts` nur im Panel-Chunk |
  | `composer/FileMentionMenu.tsx` | 1 944 | `React.lazy` beim ersten `@`-Menü |
  | `composer/PasteChips.tsx` | 1 886 | `React.lazy` bei der ersten Paste |
  | `composer/lib/folders.ts` | 571 | `import()` im Drop-/Paste-Pfad |
  | `shell/header-panels.tsx` (kompaktes „…“-Menü) | Teil von 2 470 | Menü unter 560 px lazy |
  | `shell/SidebarFrame.tsx` + `sidebar-layout.ts` (Leiste/Overlay unter 900 px) | Teil von 3 807 | Overlay-Teil lazy (geringer Gewinn) |

  Statisch **nötig** (kein Hebel):
  - Contracts v3: `shared/model` +2 648, `protocol` +1 130, `paths` +914, `errors` +788, `http`
    +371;
  - Shell-Bausteine: `SlotBoundary` 1 972, `side-panel/state` 1 484, `SidePanelHost` 920,
    `session-drop` 1 381;
  - Lazy-Hülle und Fallback der Dateien: `files/index` 857, `PlainReference` 420;
  - `en`-Wörterbücher (+9 851);
  - Composer-Kern: `Composer.tsx` +2 300, `drafts` +981, `pastes` 1 221, `mentions` 1 231
    (Tastatur- und Sendepfad);
  - `plan-parts` +1 129.

  gzip-Schätzung: die `de`-Wörterbücher allein ergeben ≈ 16–21 kB gzip (Quelltext ohne Kommentare
  21,5 kB gzip).
- **Auswirkung:** Das normative Budget (WP-50/WP-60) ist verfehlt; jede weitere Phase legt drauf.
- **Vorschlag:**
  - Hebel 1 (`de` lazy) allein bringt `index` etwa auf den Stand von `109c073`: raw darunter
    (≈ 380,9 kB), gzip ungefähr gleich.
  - Die Sprache kommt mit den Einstellungen. Bis der `de`-Chunk geladen ist, kurz halten
    (Suspense/Preload je gespeicherter Sprache), damit nicht kurz Englisch aufblitzt.
  - Dazu die Hebel 2–4: `todoProgress`, `FileMentionMenu`, `PasteChips` (≈ 6,7 kB raw).
  - Den Test `i18n.test.tsx:75` („registers the feature namespaces statically“) entsprechend anpassen.
  - Künftig als Summe aller Start-Chunks messen, inkl. modulepreload (`button-*.js`) und `vendor`.
- **Test-Idee:** Budget-Prüfung nach dem Build (Summe der Start-Chunks gzip gegen eine Schwelle).
- **Owner:** Koordinator (`src/web/i18n/**`, Registrierung der Wörterbücher), WP-55 (tasks), WP-57
  (composer).

#### R5W-02 [SOLLTE] Chunk-Fehler: eine Fehlerkarte je Inline-Verweis
- **Fundstelle:**
  - `src/web/App.tsx:129` (`FileLink: bounded(FILES_SLOTS.FileLink, (props) => props.path)`);
  - `src/web/shell/SlotBoundary.tsx:58` (`<div data-slot="slot-error">` + `Alert`).
- **Beschreibung:**
  - Jeder `FileLink` steckt in einer eigenen `SlotBoundary`: in Markdown-Absätzen, Inline-Code,
    Tool-Karten, Task-Ausgabe und am Chip der Plan-Datei.
  - Schlägt der `files`-Chunk fehl, rendert jede Fundstelle eine vollständige Fehlerkarte
    (`div` + `role="alert"` + „Fenster neu laden“). Typischer Auslöser: die produktive Instanz wird
    bei offenem Fenster neu gebaut, die alten Chunk-Hashes liefern 404.
  - Die Karte steht mitten im Fließtext und im `<p>`. Das ist eine ungültige Verschachtelung
    (`div` in `p`); React meldet sie im Dev-Modus.
- **Auswirkung:** Ein Transkript mit Dutzenden Pfaden wird unlesbar, Screenreader bekommen
  Dutzende Alerts. Gerade der Fall, für den `SlotBoundary` gebaut wurde, schadet so der Lesbarkeit.
- **Vorschlag:**
  - `SlotBoundary` um eine optionale `fallback`-Render-Prop erweitern.
  - Für `FileLink` als Fallback `PlainReference` bzw. den Pfad als Text verwenden.
  - Einen Chunk-Fehler höchstens einmal je Fenster laut melden.
- **Test-Idee:** Der Lazy-Import von `FileLink` wirft einen Chunk-Fehler → 20 Verweise in einem
  Absatz zeigen Text, und es gibt höchstens ein `role="alert"`.
- **Owner:** WP-58 (`SlotBoundary`), WP-60 (`App.tsx`).

#### R5W-03 [SOLLTE] Paste-Chip am Anfang umgeht die Slash-Behandlung
- **Fundstelle:**
  - `features/composer/Composer.tsx:626`: `message.startsWith('/') ? classifySlash(…)` prüft den
    Feldtext, in dem noch die Tokens stehen;
  - `:521–524`: `sendMessage` setzt die Paste-Texte erst danach per `expandPastes` ein.
- **Beschreibung:**
  - Steht ein Paste-Chip am Feldanfang und beginnt sein Text mit `/`, sieht `submit` nur das Token
    `[#1 · 40 Zeilen]` und erkennt keinen Slash-Befehl. Beispiele für solche Texte: Unix-Pfade,
    Git-Bash-Logs `/c/Users/…`, kopierte Befehle.
  - `sendMessage` schickt dann den expandierten Text, der mit `/` beginnt, roh als Prompt an die CLI.
  - Damit greifen weder die nativen Befehle (Parallax-Handling) noch die Sperre für reine
    Terminal-Befehle (`terminal`, `/config`).
  - Der Nutzer sieht im Feld kein `/`.
  - Die CLI deutet den Prompt als Slash-Befehl: ein unbekannter liefert eine Fehlermeldung statt einer
    Modell-Antwort, ein bekannter läuft ohne Parallax.
- **Auswirkung:**
  - Bei großen Pastes verhält sich der Composer unerwartet.
  - Prüfschwerpunkt 2 („Pastes … ohne Injektion in Slash-Befehle“) ist nicht erfüllt.
  - Der Antwortpfad (`submit` mit `answer`) expandiert ebenfalls ungeprüft; als Antworttext ist das
    aber unkritisch.
- **Vorschlag:**
  - Beginnt der Feldtext selbst nicht mit `/`, den Prompt nie als Befehl ankommen lassen, z. B. das
    führende `/` des expandierten Texts neutralisieren.
  - Wie die CLI einen Prompt mit führendem Leerzeichen oder Zeilenumbruch behandelt, in WP-61 live
    klären.
- **Test-Idee:** Paste mit dem Text `/clear …` am Feldanfang, dann Senden → kein nativer Befehl, und
  der Prompttext beginnt nicht mit `/`.
- **Owner:** WP-57.

#### R5W-04 [SOLLTE] Drei reale bzw. latente Test-Flakes
- **Fundstelle und Beleg:**
  1. `features/decisions/DecisionBar.test.tsx:245`:
     - `findByRole('complementary')` wartet nur auf den Panel-Rahmen; `textContent` (`'Plan v2'`)
       wird sofort geprüft.
     - Unter Last ist der Lazy-Chunk `PlanSidePanel → PlanPanel` dann noch nicht da.
     - Reproduziert: ein Fehlschlag im Lauf mit 37 Dateien (`expected 'PlanFilesTasks' to contain
       'Plan v2'`), danach 3× grün.
  2. `features/files/FilePanel.test.tsx:132` (Bild):
     - Im Lauf mit 306 Tests nach 6,7 s im Timeout.
     - Die Datei setzt kein `testTimeout`, das Web-Projekt hat 5 s (`vitest.config.ts`); der Test bei
       :245 brauchte 3,5 s.
     - Bekannt war das nur für den PDF-Test.
  3. `features/tasks/TaskStrip.test.tsx:114`: `findByRole(…, { timeout: 10_000 })` bei 5 s Testlimit
     – der Test bricht ab, bevor das `find` aufgibt.
- **Auswirkung:** `pnpm check` wird unter paralleler Last (R5, V4, Fix-Runde) zufällig rot.
- **Vorschlag:**
  1. `await screen.findByText(/Plan v2/)` bzw. `waitFor` verwenden, wie WP-60 es für
     `PlanCard.test` getan hat.
  2. `vi.setConfig({ testTimeout: 30_000 })` für die ganze Datei (Muster aus `docs/wp/FLAKES.md`).
  3. Testlimit mindestens so hoch wie der `find`-Timeout, oder ein kürzeres `find`.
- **Owner:** WP-56 (1), WP-54 (2), WP-55 (3).

#### R5W-05 [NIT] `EMAIL_PATTERN` mit quadratischem Backtracking
- **Fundstelle:** `src/web/lib/file-refs.ts:43` (verwendet in :223).
- **Beleg:**
  - `/[\p{L}\p{N}._%+-]+@…/gu` probiert in einem langen Wort ohne `@` jede Startposition bis zum Ende.
  - 50 000 Buchstaben + `/`: 873 ms; `'a@' + 'b.'.repeat(20000) + '1'`: 542 ms (Node 26).
  - `RELATIVE` und die Pfadmuster sind nicht betroffen.
- **Auswirkung:** Lange Tokens ohne Leerzeichen im Fließtext blockieren den Haupt-Thread. Beispiele:
  Base64, minifizierte Zeilen, große Markdown-Dateien im Viewer. Selten, weil `code`/`pre`
  übersprungen werden.
- **Vorschlag:**
  - Startanker per Lookbehind `(?<![\p{L}\p{N}._%+-])`.
  - Längen begrenzen: `{1,64}` für den lokalen Teil, `{1,63}` je Label.
  - Vorfilter `text.includes('@')`.
- **Test-Idee:** Zeitgrenze für ein Wort mit 50 000 Zeichen (< 50 ms).
- **Owner:** WP-55.

#### R5W-06 [NIT] Literale Trenner in UI-Texten
- **Fundstelle:**
  - `features/files/FileLink.tsx:86`: `` `${path} – ${t('files.link.line', …)}` ``;
  - `features/tasks/TasksPanel.tsx:97` und `TaskStrip.tsx:25`: `.join(' · ')`;
  - `shell/header-panels.tsx:105`: `'99+'`;
  - `features/preferences/sections/FilesSection.tsx:297`: `DEFAULT_PROGRAM_EXTENSIONS.join(', ')`.
- **Vorschlag:** Schlüssel mit Platzhaltern (z. B. `files.link.tooltip: '{path} – Zeile {line}'`) bzw.
  `Intl.ListFormat` über `format`.
- **Owner:** WP-54, WP-55, WP-58.

#### R5W-07 [NIT] Fokus geht nach „Alle stoppen“ verloren
- **Fundstelle:** `features/tasks/TasksPanel.tsx`:
  - :110 – der Knopf ist während der Rückfrage `disabled={confirming}`;
  - :120–134 – Rückfrage mit `autoFocus` auf „Abbrechen“.
- **Beschreibung:** Nach „Abbrechen“ oder „Stoppen“ verschwindet die Rückfrage samt fokussiertem
  Knopf. Der Fokus fällt auf `body`, weil der Auslöser während der Rückfrage deaktiviert war.
- **Vorschlag:** Den Fokus danach auf „Alle stoppen“ setzen; ist der Knopf verschwunden, auf die
  Panel-Überschrift.
- **Test-Idee:** „Abbrechen“ → `document.activeElement` ist „Alle stoppen“.
- **Owner:** WP-55.

#### R5W-08 [NIT] Zustand je Session wird nie aufgeräumt
- **Fundstelle:**
  - `features/tasks/state/strip.ts:11`: `parallax.tasks.strip.<sessionKey>`;
  - `features/composer/state/drafts.ts:35/72`: `parallax.composer.pastes.<sessionKey>`. Pro Session
    bis `DRAFT_PASTES_MAX_CHARS` (200 000 Zeichen); gelöschte Pastes bleiben bis zum Leeren oder bis
    zur nächsten Paste;
  - `features/composer/state/attachments.ts`: Listen und Object-URLs;
  - `shell/side-panel/state.ts:44`: `openers` hält bei entfernter Session mit offenem Panel ein
    abgehängtes Element.
- **Auswirkung:**
  - Entfernte Sessions hinterlassen verwaiste `localStorage`-Schlüssel.
  - Viele Sessions mit großen, ungesendeten Pastes erreichen die Quote (~5 MB je Origin).
  - Danach scheitern alle Schreibvorgänge still – auch Breiten, Leisten-Zustand und Entwürfe.
- **Vorschlag:**
  - Beim Entfernen einer Session Entwurf, Pastes, Strip-Schlüssel und Anhänge freigeben.
  - Beim Start verwaiste Schlüssel `parallax.*.<sessionKey>` gegen die Sessionliste prüfen.
- **Owner:** WP-57, WP-55, WP-54; zentraler Haken WP-58 (`state`).

#### R5W-09 [NIT] Dubletten mit abweichendem Verhalten
- **Fundstelle:**
  - `isLocalSession` in `features/files/lib/actions.ts:36` und in
    `shell/navigation/session-actions.tsx:153`;
  - zwei Byte-Formatierer:
    - `features/files/lib/format.ts:18` (`formatBytes`: 1024er-Schritte, Einheiten „kB/MB“);
    - `features/composer/lib/format.ts:7` (`formatFileSize`: 1000er-Schritte);
  - der eigene `/api/file`-Leser (bekannt).
- **Beleg:** Eine Datei mit 10 000 000 B (= `LIMITS.fileAttachmentBytes`) zeigt im Anhang-Chip
  „10 MB“, im Viewer „9,5 MB“.
- **Vorschlag:**
  - Ein Formatierer in `src/web/lib` mit einer Konvention, z. B. dezimal wie die Limits.
  - `isLocalSession` aus der Shell importieren (Features → Shell ist erlaubt).
- **Owner:** WP-58 (`web/lib`), WP-54, WP-57.

#### R5W-10 [NIT] Kleinigkeiten Viewer/Shell
- `features/files/state/stat-cache.ts`: Jedes `ensure` beim Mount benachrichtigt alle Abonnenten. Bei
  vielen Links in einem Render ergibt das O(n²) Selektor-Aufrufe; Benachrichtigungen bündeln.
- `features/files/state/file-document.ts`: Scheitert `file.stat` im Poll, ruft das alle 2 s `update`
  auf – ein Re-Render ohne Änderung. Nur bei Änderung setzen.
- `features/files/components/CodeView.tsx`: `col` aus `FileTarget` wird ignoriert, gesprungen wird
  nur zur Zeile. Die Spalte zur Markierung nutzen oder aus dem Ziel streichen.
- `shell/navigation/session-actions.tsx` (`openFolderInExplorer`): sendet `summary.cwd` ohne
  clientseitigen `windowsPathIssue`-Filter. Es sind Serverdaten, die der Server prüft; der Filter wäre
  nur zusätzliche Absicherung wie in `files/lib/actions.ts:52`.
- **Owner:** WP-54, WP-58.

#### R5W-11 [NIT] Testlücken und echte Wartezeiten (Schwerpunkt 7)
- Die normativen Punkte von WP-54 … 58 und WP-60 sind abgedeckt; die Testprüfung belegt sie mit
  Zeilen. Lücken:
  - Polling „nur bei sichtbarem Tab“ ist nur indirekt getestet (`SidePanelHost.test.tsx:144`; nur
    der aktive Tab ist montiert).
  - Das Bash-Stop-Flag ist nur am Helfer getestet (`rows.test.ts:166`).
  - Der Strip-Zustand je Session ist nur mit einer Session getestet.
  - `PATH_NOT_ALLOWED` für „Ordner öffnen“ ist ungetestet (`open-folder.test.tsx:83`).
  - `localStorage`-Fehler fehlen für `bar-store` (`approveFresh`; getestet ist nur ein ungültiger
    Wert, `lib.test.ts:81`) und für die Pastes in `drafts.ts` (werfender Storage, kaputtes JSON). Der
    Code selbst ist defensiv.
- Echte Wartezeiten:
  - `FileLink.test.tsx:29`: 60 ms für den 50-ms-Batch; besser Fake-Timer wie in `stat-cache.test.ts`.
  - `TranscriptView.test.tsx:283/291`: 20 ms vor negativen Assertions – die können falsch grün sein.
  - `TranscriptView.test.tsx:314`: 250 ms gegen das 150-ms-Fenster von virtua.
  - In den Phase-3-E2E-Specs gibt es keine festen Wartezeiten.
- `SidePanelHost.test.tsx:301` behauptet „Tab leaves the panel“, drückt aber nie Tab.
- `e2e/phase3-files.spec.ts:119`: 3 s für eine Änderung bei 2-s-Poll – normativ, aber bei 3 Workern
  knapp.
- **Owner:** WP-54, WP-55, WP-56, WP-57, WP-58.

### Empfohlene Fix-Pakete
- **F-Bundle** (Koordinator i18n, WP-55, WP-57): R5W-01 – `de` lazy, `todoProgress` auslagern,
  `FileMentionMenu`/`PasteChips` lazy; Budget-Prüfung als Test.
- **F-Web** (WP-55, WP-57, WP-58, WP-60): R5W-02, R5W-03, R5W-07; optional R5W-05, R5W-06, R5W-09.
- **F-Tests** (WP-54, WP-55, WP-56): R5W-04 und Teile von R5W-11.
- R5W-08 und R5W-10 können nach WP-61 folgen.

### Hinweise für WP-61
1. **Slash über Paste-Chip** (falls R5W-03 bis dahin offen ist): großen Text mit `/…` am Anfang
   einfügen und senden, das Verhalten der CLI notieren. Mit Fix prüfen, dass er als normaler Prompt
   ankommt.
2. **Chunk-Fehler nach einem Neubau** (R5W-02):
   - Nur auf einer Dev-Instanz mit eigenem `PARALLAX_HOME`, nie mit der produktiven Instanz.
   - Fenster offen lassen und neu bauen.
   - Dann Pfad-Links, Dateien-Panel und Plan-Panel öffnen.
3. **Plan-Live-Vorschau** mit echtem `Write`-Streaming (`inputPartial` der echten CLI):
   - Umlaute und Escapes (`ü`, Surrogate bei Emojis);
   - Flackern;
   - Last bei langen Plänen (Markdown wird je Delta neu gerendert);
   - Übergang zur Datei nach dem Schreiben.
4. **Viewer live:**
   - Datei im echten Editor speichern → Neuladen in ≤ 3 s.
   - PDF im `iframe` und Bilder mit echten Dateien.
   - Strg+Klick und Mittelklick → der eingestellte Editor (Notepad++, VS Code, eigenes Programm).
   - Das Standardprogramm nur für harmlose Endungen.
5. **@-Picker** in einem großen Git-Repository: Antwortzeit von `files.project`, Fuzzy-Filter bei
   ≥ 10 000 Dateien.
6. **Anhänge:**
   - PDF bzw. Datei knapp unter und über 10 MB (Anzeige, R5W-09);
   - einen Ordner aus dem Explorer auf die Pane ziehen (1-Byte-Lesetest in `folders.ts`);
   - die Gesamtgrenze von 20 MB.
7. **Tasks:** Stop je Agent/Bash und „Alle stoppen“ mit echten Hintergrund-Tasks (Flag
   `TASK_STOP_BASH`), dabei den Fokus nach der Rückfrage prüfen (R5W-07).
8. **Schmales Fenster** im Chrome-App-Modus bei 125 % und 150 % Skalierung: unter 900 px Leiste bzw.
   Overlay, unter 560 px Kopfzeilen-Menü.
9. **Bundle** nach der Fix-Runde mit derselben Methode messen:
   - Summe aller Start-Chunks inkl. `button-*.js` und `vendor`, gzip 9;
   - Zuordnung je Modul über die Sourcemap: Mappings des `index`-Chunks dekodieren und die Bytes je
     `sources`-Eintrag summieren.
