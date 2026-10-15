# src/web/features – Feature-Bereiche

Ein Unterordner pro Feature; jedes Feature gehört genau einem Paket (diese README pflegt der
Koordinator):

- `transcript/` (WP-15): Streaming-Markdown, Diff, Bash, generischer Fallback, virtualisierte
  Liste (`virtua`), Shiki nur auf geschlossenen Code-Blöcken. Liefert die Slots `Markdown` und
  `ToolInputPreview`, nutzt den Slot `DecisionCard` (Plan-Karte über `tool_call.decision`).
- `decisions/`, `composer/` (WP-16): Permission-, Frage- und Plan-Karten, angedockte
  Entscheidungsleiste, Queue, Stop, Entwürfe, Picker, Context-Gauge. Liefert `DecisionCard`,
  nutzt `Markdown` und `ToolInputPreview`.

Aufbau eines Feature-Ordners (R0-03): `i18n/{en,de}.ts` (Namespace = Ordnername, Stubs von WP-14),
`playground.tsx` (`export const demos: PlaygroundDemo[]`, per `import.meta.glob` gefunden),
optional `components/`, `state/`, `lib/` für feature-eigene Teile. Features importieren einander
**nie**; gemeinsame Komponenten laufen über `FeatureSlots` (`src/web/shell/slots.tsx`), die WP-20 in
`App.tsx` verdrahtet. `src/web/{ui,lib,state,i18n}` sind in Welle 1b read-only.

Kein `rehype-raw`, kein `dangerouslySetInnerHTML` (Review C.10). `streamdown` hängt von
`rehype-raw` ab: Plugins so setzen, dass kein Roh-HTML gerendert wird.
