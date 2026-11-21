# src/web/features/search – Volltextsuche (Ausbau 1)

Owner: **WP-115**. Auftrag: `docs/wp/WP-110.md` §3.6, §6 und §8; Entscheidung ADR-255. Angelegt als Gerüst in WP-110 (nur
README und leerer Namensraum `search`).

- Slot `SearchDialog` (fensterweit): behandelt die Shell-Anfrage `search.open` (Strg+Umschalt+F, Schnellwechsler
  „In Inhalten suchen: …“), fragt per `search.query` (Antwort im Ack, höchstens `LIMITS.searchHitsMax` Treffer;
  eine neuere Anfrage beendet die ältere mit `SEARCH_FAILED {reason: 'superseded'}`).
- Ein Treffer öffnet die Session und lädt die Einträge um den Treffer per `transcript.loadAround`.
- Nur Rechner mit `HostState.features.search`.

Feature importiert keine anderen Features; Querverbindungen über `src/web/shell/requests.ts`.
