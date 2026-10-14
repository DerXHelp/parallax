# src/server/sync – Sync-Protokoll (WP-10)

Handshake (`hello`), Session-Summaries an alle Clients, Transkript-Abos mit Sequenznummer und
Ringpuffer, Befehle mit `cmdId`/`ack`, Delta-Bündelung. Nachrichtentypen kommen aus
`@shared/protocol` (WP-02). Details: `docs/plan.md`, Review A.2.
