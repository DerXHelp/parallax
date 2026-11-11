# src/server/files – Datei-Dienst (Phase 3)

Owner: **WP-53** (außer `ports.ts`: Koordinator, eingefroren). Auftrag: `docs/wp/WP-53.md`
(Design: `docs/wp/WP-50.md`, ADR-140 … ADR-146).

Metadaten und Inhalte von Dateien, auf die sich eine Session bezieht (Viewer, Dateiverweise,
Dateien-Panel, @-Picker), sowie der Start externer Programme (Editor, Explorer, Standardprogramm).
Jeder Zugriff läuft durch die Prüfkette aus ADR-141 (Stringfilter → Richtlinie am angefragten
String ohne fs-Zugriff → Links je Segment → `realpath` → Richtlinie am Ziel).

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `ports.ts` | `FileEntryInfo`, `FileEntryLookup`, `FileContent`, `FileContentProvider`, `FileService` (nur Typen) | Koordinator |

Stand WP-50 Teil 2: nur der Port, noch kein Dienst. Host-Befehle `file.*`, `files.*` und
`editor.detect` antworten bis zur Verdrahtung (WP-60) `NOT_IMPLEMENTED`.
