# src/web/features/transcript – Transkript (WP-15, WP-37, WP-55, WP-63)

Chat-Ansicht einer Session: virtualisierte Liste, Streaming-Markdown, Tool-Renderer, System-Items,
Plan-Karte; seit WP-37 Lightbox für Bilder, `handoff`-Zeile, Windows-Pfade im Markdown (V2-12);
seit WP-55 klickbare Dateiverweise (Slot `FileLink`), Stop und Ausgabedatei in der Agent-Karte;
seit WP-63 die **kompakte Ansicht** (Standard): jede Folge von Arbeitsschritten zwischen zwei
sichtbaren Einträgen ist eine Gruppenzeile, ihre Bilder stehen als Galerie darunter (auch zugeklappt),
die Lightbox blättert durch die Galerie; Limit-Warnungen (`rate_limit` allowed/allowed_warning) erscheinen
nicht mehr. Details, Entscheidungen und Lücken: `docs/wp/WP-15.md`, `docs/wp/WP-37.md`,
`docs/wp/WP-55.md`, `docs/wp/WP-63.md`.

## Exporte (für WP-20 und WP-16 nur über Slots)

| Datei | Export | Zweck |
|---|---|---|
| `slots.tsx` | `TRANSCRIPT_SLOTS` (`Transcript`, `Markdown`, `ToolInputPreview`), `TranscriptSlot`, `ToolInputPreviewSlot` | WP-20 spreizt `TRANSCRIPT_SLOTS` in `APP_SLOTS`; Transcript und ToolInputPreview als Lazy-Chunks |
| `TranscriptView.tsx` | `TranscriptView` (`{ sessionKey }`, `memo`) | die Liste selbst (Tests, Playground) |
| `renderers/index.ts` | `toolRenderers: Record<string, ToolRenderer>`, `getToolRenderer(name)`, `genericToolRenderer`, Typen `ToolRenderer`, `ToolBodyProps`, `ToolPreviewProps`, `ToolFileRef` | Renderer-Registry; unbekannte und MCP-Tools → generischer Fallback |
| `markdown/Markdown.tsx` | `Markdown` (`{ text, streaming?, sessionKey?, baseDir? }`), `preloadMarkdown()` | sicheres Markdown, Renderer lazy; mit `sessionKey` werden Dateiverweise zu `FileLink` (relativ zu `baseDir` bzw. cwd) |
| `ToolInputPreview.tsx` | `ToolInputPreview` (`{ toolName, input, sessionKey? }`) | Eingabe-Vorschau für Permission-Karten (WP-16) |
| `playground.tsx` | `demos`, `slots` | Playground `#playground=transcript/<id>` (u. a. `files`: alle Verweisarten; `compact`: lange Bash-Folge, Gruppe mit Fehler, Bild-Schub, laufende Gruppe) |

## Aufbau

| Ordner | Inhalt |
|---|---|
| `items/` | eine Komponente je Item-Art: `TranscriptRow` (`useItem` je Zeile), `MessageRows` (User – lange Nachricht ab 14 Zeilen/2000 Zeichen zugeklappt mit „Alle n Zeilen anzeigen“, V4-07 –, Assistant, Thinking, Queue), `ToolCallRow` (Zeile + Bilder des Ergebnisses als Vorschau unter der Zeile, auch zugeklappt, R4W-03 + Entscheidung; Datei des Aufrufs als `FileLink` neben dem Umschalter, WP-55), `AgentCard` (Stop, Fortschritt, Ausgabedatei), `PlanCard` (Plan-Datei als Link), `SystemRow` (Rate-Limit-Fenster übersetzt, V3-13; nur `rejected`, Warnungen rendern nichts – WP-63; Ausgabedatei einer Task-Meldung), `TurnFooter`, `StepGroupRow` (WP-63: Gruppenzeile `▸ 12 Schritte · 9× Bash, 2× Read · 1 Min. 40 s`, läuft die Gruppe: der aktuelle Schritt; roter Fehlerzähler öffnet die Gruppe; Galerie darunter) |
| `renderers/` | Tool-Renderer (`shell`, `edit`, `read`, `search`, `misc` inkl. `NotebookEdit`, `generic`) + gemeinsame Teile (`parts`: u. a. `ToolResultImages` – die Bilder eines Ergebnisses genau einmal unter der Zeile; die Bodies zeigen nur Text). Optional `file(item)`: Pfad + Zeile für den Link in der Zeile |
| `markdown/` | `Markdown` (Wrapper, Klartext-Fallback), `MarkdownRenderer` (react-markdown + remark-gfm, Lazy-Chunk), `rehype-file-refs` (markiert Verweise im Fließtext als `span[data-file-ref]`, nie in Links/Code), `FileReference` (Kontext Session/Basis, `FileLink` mit `verify`, UNC/Device bleiben Text; Inline-Code über `findCodeRefs`: ein Code-Span ist als Ganzes ein Pfad, auch mit Leerzeichen, V4-01) |
| `components/` | `Disclosure` (dünner Wrapper um `@web/ui/disclosure` mit `useExpanded`), `CodeBlock` und `DiffView` (dünne Wrapper um `@web/ui/code-block`/`@web/ui/diff-view` mit den Texten des Namespace und dem Hinweis „Kopiert“, WP-50 Teil 2), `ToolFileLink` (Pfad aus Tool-Ein-/Ausgabe als `FileLink` ohne `verify`), `AnsiText`, `CappedContent`/`TruncationNotice` (Inline-Budget für Volltexte), `ToolStatus`, `ModelBadge`, `ImageThumb` (Blob-Bild als Knopf → Lightbox, WP-37; `loading="lazy"` nur mit bekannter Größe, V3-12), `ImageViewer` (die eine Lightbox der Liste, außerhalb der virtualisierten Zeilen; mit Galerie: vor/zurück, WP-63), `ImageGallery`/`ToolImagesGallery` (Thumbnail-Raster einer Gruppe bzw. benachbarter Bild-Ergebnisse, WP-63) – Kompositionen aus `@web/ui` |
| `lib/` | reine Helfer: `ansi` (Scanner), `markdown-blocks`, `safe-url` (http(s); lokale Link-Ziele nur für den FileLink), `tool-input` (zod-Leser), `text` (`clipForDisplay`, `INLINE_TEXT_BUDGET`, `collapsedPreview`/`COLLAPSE_AFTER` für lange Nutzer-Nachrichten, `previewImages`: Bilder eines Ergebnisses, ohne eigenen Namen nach `input.file_path` benannt, V3-09), `rate-limit` (bekannte `rateLimitType`-Fenster), `windows-paths` (`preserveWindowsPaths`, V2-12: Backslashes von Laufwerks-, UNC- und Device-Pfaden im Fließtext bleiben sichtbar, bei Laufwerkspfaden auch hinter einem Leerzeichen im Ordnernamen, V4-01), `grouping` (WP-63: `classifyItem` – Rolle sichtbar/Schritt/Schritt mit Bild/versteckt –, `buildRows` – ein O(n)-Durchlauf zu Zeilen, kompakt oder „Alle Schritte“ –, `summarizeGroup` – was die Gruppenzeile sagt); der Verweis-Erkenner liegt in `@web/lib/file-refs` |
| `state/` | `expansion` (Auf/Zu je Item, übersteht Re-Mounts der Liste), `full-text` („Vollständig laden“, Blob-LRU 16 Texte/8 Mi Zeichen, austauschbarer Loader), `blob-source` (`blobSource`/`setBlobSourceResolver` – Playground ohne Blob-Server, `downloadNameOf` für „Speichern unter“, Endung über `@web/lib/media-types`), `tasks` (`useSessionCwd`, `stopTask` – `session.stopTask`, `TASK_NOT_FOUND` still), `groups` (WP-63: offene Schrittgruppen je Session, Schlüssel `group:<erste Item-ID>` – übersteht Streaming und Virtualisierung, Standard zu) |
| `playground/` | Demo-Daten (`data.ts`), Live-Skript (`live.ts`), `TranscriptDemo` |
| `i18n/` | `en.ts`/`de.ts` (Namespace `transcript`) |

`context.ts`: `TranscriptSettingsContext` (Session-Modell, Kosten sichtbar, Zeilenkomponente),
`QueuedIdsContext` und `ImageViewerContext` (öffnet die Lightbox der Liste; ohne sie hat ein
`ImageThumb` eine eigene). `testing.ts`: Test-Helfer (ResizeObserver-/Layout-Stub und
Scroll-Ereignisse für virtua, `startTranscriptScenario`) – nur in Tests.

## Regeln

- Session-Daten nur über `@web/state/hooks` (`useTopLevelItemIds`, `useItem`, `useChildItemIds`,
  `useSessionMeta`, `useSessionSelector`, `useDecision`); Deltas rendern nur ihre Zeile neu.
- Kein Roh-HTML: react-markdown mit `skipHtml`, ohne rehype-raw; Links/Bilder nur http(s)
  (`lib/safe-url.ts`), Bilder werden nie geladen (Link); Terminal-Ausgabe über den ANSI-Scanner als
  Text; kein `dangerouslySetInnerHTML`. Geladen werden nur Blob-Bilder des eigenen Servers
  (`/api/blob/<id>`, Thumbnails und Lightbox).
- Dateiverweise nur über den Slot `FileLink`: Text/Inline-Code mit `verify` (Link erst nach
  `file.statMany`, F1), Tool-Pfade ohne; UNC-/Device-Pfade erreichen den Slot nie. Code-Blöcke und
  der noch streamende letzte Block werden nicht verlinkt.
- Ans Ende scrollen nur über `scrollTop` (nicht virtuas `scrollToIndex`, das einen Scroll nach oben
  während des Streamings zurückholt – FIX-E2E-EDGE157, WP-55).
- Schweres lädt lazy: Markdown-Renderer, Shiki (`shiki/core` + JS-Regex-Engine, Grammatiken
  einzeln), `diff`; die Slots `Transcript`/`ToolInputPreview` selbst sind Lazy-Chunks.
- Farben nur über Tokens: Shiki nutzt das CSS-Variablen-Theme (`--shiki-token-*` → Tokens in
  `@web/ui/code-block`), ANSI-Farben → `text-destructive`, `text-success` … (`AnsiText`).
- Neuer Tool-Renderer: Datei in `renderers/`, Eintrag in `toolRenderers`, Test in
  `renderers/renderers.test.tsx`, Demo-Item in `playground/data.ts`.

## Kompakte Ansicht (WP-63)

- Die Ansicht („Kompakt“/„Alle Schritte“) liest die Liste aus `@web/state/transcript-view`; gesetzt
  wird sie auf der Einstellungsseite (features/preferences) – beide nur über dieses Modul.
- Rollen (`lib/grouping.ts`): **sichtbar** – Nutzer- und Assistenten-Nachrichten, Turn-Fuß,
  Entscheidungen (Tool-Aufruf mit `decision`, AskUserQuestion, ExitPlanMode), Agent-Karten,
  Fehler-/Warn-Notices, `rate_limit` rejected, Compact-Grenze, neue Unterhaltung, API-Retry,
  Modell-Fallback, Permission denied, Übergaben, Task-Meldungen; **Schritt** – Thinking, jeder andere
  Tool-Aufruf, ruhige System-Items (Hooks, Memory, Notifications, informational auf Stufe info,
  unbekannte); **versteckt** – `rate_limit` allowed/allowed_warning (alte Logs), trennt keine Gruppe.
- Ab 2 Schritten eine Gruppe; ein einzelner Schritt bleibt eine normale Zeile. Eine offene Gruppe
  folgt mit ihren Schritten als eingerückte Zeilen (`data-nested`); deren Bilder stehen nur in der
  Galerie (`hideImages`). In „Alle Schritte“ bilden ≥2 benachbarte Bild-Ergebnisse eine Galerie-Zeile.
- Auf-/Zuklappen einer Gruppe folgt nicht dem Ende: die Liste behält ihren Offset (auch während virtua
  die neuen Zeilen misst), die angeklickte Gruppenzeile bleibt stehen; danach klebt sie nur wieder
  unten, wenn das Ende sichtbar ist, sonst erscheint „Zu den neuesten“ (`TranscriptView.tsx`).
- Die Liste vergleicht nur die Rollen-Codes flach (`selectItemCodes`, WeakMap je `view.items`): ein
  Delta, das keine Rolle ändert, baut keine Zeilen neu; eine Gruppenzeile rendert nur neu, wenn sich
  eines ihrer Items ändert (`useItems`).
