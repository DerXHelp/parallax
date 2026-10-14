# src/web/features – Feature-Bereiche

Ein Unterordner pro Feature, z. B.:

- `transcript/` (WP-15): Streaming-Markdown, Diff, Bash, generischer Fallback, virtualisierte
  Liste (`virtua`), Shiki nur auf geschlossenen Code-Blöcken.
- `decisions/`, `composer/` (WP-16): Permission-, Frage- und Plan-Karten, angedockte
  Entscheidungsleiste, Queue, Stop, Entwürfe, Picker, Context-Gauge.

Kein `rehype-raw`, kein `dangerouslySetInnerHTML` (Review C.10). `streamdown` hängt von
`rehype-raw` ab: Plugins so setzen, dass kein Roh-HTML gerendert wird.
