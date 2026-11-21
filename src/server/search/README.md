# src/server/search – Volltextsuche (Ausbau 1)

Suche über die Sessions dieses Rechners (`docs/wp/WP-110.md` §3.6; ADR-255). Angelegt als Gerüst in
WP-110, gefüllt von WP-112.

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `commands.ts` | `createSearchCommands()` – Host-Befehle `search.query` (Antwort im Ack, keine Push-Nachricht; eine neue Anfrage desselben Fensters beendet die alte mit `SEARCH_FAILED {reason: 'superseded'}`) und `transcript.loadAround` (über `TranscriptStore.readAround`); bis WP-112 ein Stub (NOT_IMPLEMENTED) | WP-110 (Gerüst), WP-112 |

Regeln (ADR-255): kein Index in v1; der Scan läuft in einem Worker-Thread, Groß-/Kleinschreibung egal,
höchstens `LIMITS.searchHitsMax` Treffer, neueste zuerst, abbrechbar; Werkzeugausgaben nur mit
`includeToolOutput`. Verdrahtet in `app/compose.ts` (Koordinator).
