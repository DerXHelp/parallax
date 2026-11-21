# src/server/search – Volltextsuche (Ausbau 1)

Suche über die Sessions dieses Rechners (`docs/wp/WP-110.md` §3.6; ADR-255). Angelegt als Gerüst in
WP-110, gefüllt von WP-112 (Ergebnis und Stolpersteine: `docs/wp/WP-112.md`).

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `commands.ts` | `createSearchCommands(deps?)` – Host-Befehle `search.query` (archivierte Sessions nur mit `includeArchived`; vorher `TranscriptStore.flush()`, damit gepufferte Zeilen in den Dateien stehen; Antwort im Ack, keine Push-Nachricht) und `transcript.loadAround` (über `TranscriptStore.readAround`; `ENTRY_NOT_FOUND`, `CONVERSATION_NOT_FOUND`, unbekanntes Item → `VALIDATION_FAILED {reason:'item_not_found'}`); `close()` beim Herunterfahren. Ohne `deps` (bis zur Verdrahtung in `app/compose.ts`) antworten beide mit `NOT_IMPLEMENTED` | WP-110 (Gerüst), WP-112 |
| `service.ts` | `createSearchService({home, …})` – je Anfrage ein Worker-Thread (`eval`, `resourceLimits` 128 MB Heap, `unref`); je Fenster (`clientId`) höchstens eine Suche: eine neue beendet die alte mit `SEARCH_FAILED {reason:'superseded'}`; höchstens `SEARCH_MAX_CONCURRENT` (2) Worker gleichzeitig, weitere warten; Zeitlimit `SEARCH_TIMEOUT_MS` (20 s) → `timeout`, Absturz oder ungültige Antwort des Workers → `worker`, ein vom Worker gemeldeter Lesefehler und `close()` → `failed`; jede Trefferzeile wird mit `searchHitSchema` geprüft | WP-112 |
| `workerSource.ts` | `SEARCH_WORKER_SOURCE` – der Worker als CommonJS-Text (`String.raw`, nie `${` darin): liest Transkript-Logs in 64-KiB-Stücken zeilenweise (Zeilen über `SEARCH_MAX_LINE_BYTES` werden übersprungen und gezählt), Vorfilter auf den JSON-escapten Suchtext vor `JSON.parse`, die letzte Zeile eines Items gilt (`remove` löscht), dazu Titel, Zusammenfassung des letzten Turns und Plan-Dateien `v<N>.md`; Ausschnitt höchstens `LIMITS.searchSnippetChars` um den ersten Treffer (Zeilenumbrüche als Leerzeichen), Bereiche je Treffer | WP-112 |

Regeln (ADR-255): kein Index in v1; der Scan läuft in einem Worker-Thread, Groß-/Kleinschreibung egal,
höchstens `LIMITS.searchHitsMax` Treffer, neueste zuerst, abbrechbar; Werkzeugausgaben (Eingabe-Strings
und Text-Ergebnisse von `tool_call`) nur mit `includeToolOutput`. Thinking wird nicht durchsucht.
Sessions werden nach `lastActivityAt` absteigend gescannt; ist die Liste voll und kann eine ältere
Session keinen neueren Treffer mehr liefern, endet der Scan früh (`truncated: true`, konservativ).

Tests: `service.test.ts` (echter Worker über einem Temp-Home), `commands.test.ts` (Stub-Dienst,
Speicher-Stores).
