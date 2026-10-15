# src/web/features/transcript – Transkript (WP-15)

Chat-Ansicht einer Session: virtualisierte Liste, Streaming-Markdown, Tool-Renderer, System-Items,
Plan-Karte. Details, Entscheidungen und Lücken: `docs/wp/WP-15.md`.

## Exporte (für WP-20 und WP-16 nur über Slots)

| Datei | Export | Zweck |
|---|---|---|
| `slots.tsx` | `TRANSCRIPT_SLOTS` (`Transcript`, `Markdown`, `ToolInputPreview`), `TranscriptSlot`, `ToolInputPreviewSlot` | WP-20 spreizt `TRANSCRIPT_SLOTS` in `APP_SLOTS`; Transcript und ToolInputPreview als Lazy-Chunks |
| `TranscriptView.tsx` | `TranscriptView` (`{ sessionKey }`, `memo`) | die Liste selbst (Tests, Playground) |
| `renderers/index.ts` | `toolRenderers: Record<string, ToolRenderer>`, `getToolRenderer(name)`, `genericToolRenderer`, Typen `ToolRenderer`, `ToolBodyProps`, `ToolPreviewProps` | Renderer-Registry; unbekannte und MCP-Tools → generischer Fallback |
| `markdown/Markdown.tsx` | `Markdown` (`{ text, streaming?, sessionKey? }`), `preloadMarkdown()` | sicheres Markdown, Renderer lazy |
| `ToolInputPreview.tsx` | `ToolInputPreview` (`{ toolName, input, sessionKey? }`) | Eingabe-Vorschau für Permission-Karten (WP-16) |
| `playground.tsx` | `demos`, `slots` | Playground `#playground=transcript/<id>` |

## Aufbau

| Ordner | Inhalt |
|---|---|
| `items/` | eine Komponente je Item-Art: `TranscriptRow` (`useItem` je Zeile), `MessageRows` (User, Assistant, Thinking, Queue), `ToolCallRow` (Zeile + Entscheidung), `AgentCard`, `PlanCard`, `SystemRow`, `TurnFooter` |
| `renderers/` | Tool-Renderer (`shell`, `edit`, `read`, `search`, `misc`, `generic`) + gemeinsame Teile (`parts`) |
| `markdown/` | `Markdown` (Wrapper, Klartext-Fallback) und `MarkdownRenderer` (react-markdown + remark-gfm, Lazy-Chunk) |
| `components/` | `Disclosure`, `CodeBlock` (+ `use-highlight`), `DiffView`, `AnsiText`, `CappedContent`/`TruncationNotice`, `CopyButton`, `ToolStatus`, `ModelBadge` – Kompositionen aus `@web/ui` |
| `lib/` | reine Helfer: `ansi` (Scanner), `markdown-blocks`, `safe-url`, `diff`, `languages`, `highlight` (Shiki, Lazy-Chunk), `tool-input` (zod-Leser), `text` |
| `state/` | `expansion` (Auf/Zu je Item, übersteht Re-Mounts der Liste), `full-text` („Vollständig laden“, Blob-LRU, austauschbarer Loader) |
| `playground/` | Demo-Daten (`data.ts`), Live-Skript (`live.ts`), `TranscriptDemo` |
| `i18n/` | `en.ts`/`de.ts` (Namespace `transcript`) |

`context.ts`: `TranscriptSettingsContext` (Session-Modell, Kosten sichtbar, Zeilenkomponente) und
`QueuedIdsContext`. `testing.ts`: Test-Helfer (ResizeObserver-/Layout-Stub für virtua,
`startTranscriptScenario`) – nur in Tests.

## Regeln

- Session-Daten nur über `@web/state/hooks` (`useTopLevelItemIds`, `useItem`, `useChildItemIds`,
  `useSessionMeta`, `useSessionSelector`, `useDecision`); Deltas rendern nur ihre Zeile neu.
- Kein Roh-HTML: react-markdown mit `skipHtml`, ohne rehype-raw; Links/Bilder nur http(s)
  (`lib/safe-url.ts`), Bilder werden nie geladen (Link); Terminal-Ausgabe über den ANSI-Scanner als
  Text; kein `dangerouslySetInnerHTML`.
- Schweres lädt lazy: Markdown-Renderer, Shiki (`shiki/core` + JS-Regex-Engine, Grammatiken
  einzeln), `diff`; die Slots `Transcript`/`ToolInputPreview` selbst sind Lazy-Chunks.
- Farben nur über Tokens: Shiki nutzt das CSS-Variablen-Theme (`--shiki-token-*` → Tokens in
  `CodeBlock`), ANSI-Farben → `text-destructive`, `text-success` … (`AnsiText`).
- Neuer Tool-Renderer: Datei in `renderers/`, Eintrag in `toolRenderers`, Test in
  `renderers/renderers.test.tsx`, Demo-Item in `playground/data.ts`.
