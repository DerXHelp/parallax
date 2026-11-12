# src/web/features/files – Dateien (Phase 3, WP-54)

Owner: **WP-54**. Auftrag und Ergebnis: `docs/wp/WP-54.md` (Design: `docs/wp/WP-50.md`, ADR-141 … ADR-146, ADR-150).

Datei-Viewer (Tab „Datei“ des Seitenpanels, Slot `FilePanel`), klickbare Dateiverweise mit Aktionen
(Slot `FileLink`: Viewer, Editor, Explorer, Standardprogramm, Pfad kopieren) und „Dateien dieser
Session“ (Slot `FilesPanel`) über die Host-Befehle `file.*`/`files.*` und `GET /api/file`.

## Exporte (nur über Slots, WP-60 verdrahtet `...FILES_SLOTS` in `App.tsx`)

| Datei | Export | Zweck |
| --- | --- | --- |
| `index.ts` | `FILES_SLOTS` (`FileLink`, `FilePanel`, `FilesPanel`), nur Typen `FileRef`, `FileSource` | alle drei Slots als Lazy-Chunks; `FileLink` zeigt bis zum Laden den Klartext (`components/PlainReference`, wie „wird geprüft“), die Panels nichts. Keine Wert-Exporte: sie zögen ihr Modul in den Start-Chunk (Tests/Playground importieren direkt) |
| `FileLink.tsx` | `FileLink` (`FileLinkSlotProps`, `memo`, auch Default-Export) | Varianten `inline`/`chip`/`menu`; unsichere Pfade (`windowsPathIssue`) bleiben Text ohne Befehl; `verify` → Link erst nach `file.statMany` (Stat-Cache), `PATH_NOT_ALLOWED` gepunktet mit Tooltip; Klick → `openFile`, Strg-/Mittelklick → Editor, Rechtsklick → Aktionen |
| `FilePanel.tsx` | `FilePanel` (`FilePanelSlotProps`, Default-Export) | Kopf (Name ganz, Ordner vom Anfang gekürzt, Art, Größe über `@web/lib/bytes` dezimal wie überall, Änderungszeit, Badge „Letzter bekannter Stand“ nach einem Fehler, Aktionen, Markdown gerendert/Quelle), Inhalt je Art, Fehler als `Alert role="alert"`, Hinweis „gekürzt“; live: `file.stat` alle 2 s, solange sichtbar, Neuladen nach Write/Edit |
| `FilesPanel.tsx` | `FilesPanel` (`{sessionKey}`, Default-Export), `FILES_ROW_HEIGHT` | `files.session` beim Öffnen, danach 2 s entprellt nach Datei-Tool-Calls; virtua-Liste, relative Pfade (vom Anfang gekürzt, der Name bleibt ganz), Op-Badges, Filter (`@web/lib/fuzzy`), Kontextmenü, leer/gekürzt |
| `playground.tsx` | `demos`, `slots` | Playground `#playground=files/<id>` (Host mit allen Tabs, schmales Fenster, Viewer je Art, Links, Dateien-Panel) |
| `testing.ts` | `FILES_SESSION_KEY`, `startFilesScenario`, `fakeHostFileSource`, `installResizeObserver` | nur Tests und Playground |

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `components/` | `CodeView` (Lazy-Chunk: virtualisierte Codeansicht, Shiki bis `HIGHLIGHT_MAX_CHARS`, Zeilensprung mit Markierung und Fokus, Spalte unterstrichen und seitlich sichtbar gescrollt), `ImageView` (Einpassen/100 %, Lightbox), `PdfView` (Lazy-Chunk: `iframe` ohne `sandbox`, Herunterladen, Standardprogramm), `FileIcon`/`fileIconFor`, `FileActionItems`/`FileActionsMenu` (Aktionen als Kontext- oder Dropdown-Menü), `PathText` (Pfad einzeilig, vom Anfang gekürzt: Box `direction: rtl`, Pfad als `<bdi dir="ltr">`), `PlainReference`/`defaultFileLinkLabel` (Klartext-Form eines Verweises, einziger Teil im Start-Chunk) |
| `lib/` | reine Helfer: `actions` (`fileActions`, `activateFile`, `openInViewer`, `openExternally`, `copyFilePath` – Editor/Explorer nur für den lokalen Host (`isLocalSession` aus `@web/shell/navigation/session-actions`), Standardprogramm nur bei `isDefaultProgramAllowed`), `columns` (`columnOffset`: Spalte → `ch`-Versatz mit Tab-Stopps), `file-tools` (`toolFilePath`, `fileToolIndex`: letzte fertige Schreibzeit je Datei + Signatur aller fertigen Datei-Tools), `paths` (`relativeToRoot`, `parentPath`, `fileName`). Größen: `formatFileSize` aus `@web/lib/bytes` |
| `state/` | `stat-cache` (`StatCache`/`statCache`/`useFileStat`: 50 ms Sammelzeit, ≤ 100 Pfade je Befehl, TTL 30 s, LRU 2000, Invalidierung durch Write/Edit, Benachrichtigung gebündelt je Microtask), `file-source` (Loader-Naht `FileSource {text, url}`, `httpFileSource` über `GET /api/file`, `setFileSource`), `file-document` (`FileDocumentLoader`/`useFileDocument`: Stat-Polling, Inhalt nur für Text/Markdown, `stale` = letzter bekannter Stand nach einem Fehler, derselbe Fehler erneut ohne neuen Zustand), `session-files` (`useSessionFiles`), `file-tools` (`useFileWriteStamp`, `useFileToolSignature`) |
| `playground/` | `FilesDemo` (Szenario + FakeHost-Dateitabelle), `media.ts` (erzeugtes Bild/PDF ohne Server) |
| `i18n/` | `en.ts`/`de.ts` (Namespace `files`, registriert in `src/web/i18n/dictionaries.ts` bzw. `dictionary.de.ts`, ADR-153) |

## Regeln

- Pfade nur über `@shared/paths` (`windowsPathIssue`, `windowsPathsEqual`, `windowsPathKey`); UNC,
  Device und ADS werden nie an den Server geschickt.
- Inhalte lädt nur `state/file-source` (eigener Server, `GET /api/file`); Markdown rendert der Slot
  `Markdown` mit `baseDir`, nie Roh-HTML.
- Schweres lädt lazy: `FileLink` (mit Stat-Cache und Aktionen), Viewer, Codeansicht, PDF, Dateien-Panel;
  im Start-Chunk liegen nur `index.ts`, `PlainReference` und die Wörterbücher.
- Querverbindungen zur Shell nur über `requestShell` (`openFile`, `sidePanel`) und
  `@web/shell/side-panel/state`.
