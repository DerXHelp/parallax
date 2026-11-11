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
