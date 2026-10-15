# src/server/sync – Sync-Protokoll (WP-10)

Handshake (`hello`), Session-Summaries an alle Clients, Transkript-Abos mit Sequenznummer und
Ringpuffer, Befehle mit `cmdId`/`ack`, Delta-Bündelung. Nachrichtentypen kommen aus
`@shared/protocol` (WP-02). Details: `docs/plan.md`, Review A.2; `docs/architecture.md` §5.

- **Port (eingefroren seit WP-02, Änderung nur per Contract-Änderung):** `ports.ts` –
  `SessionPublisher`, `SessionSource`, `ClientPresence`, `CommandError`, Stores
  (`TranscriptStore`, `BlobStore`, `RegistryStore`, `DecisionStore`, `SettingsStore`,
  `StoreWarnings`), `transcriptLogLineSchema`; feste WP-10-Modulnamen im Kopfkommentar.
- Der Hub vergibt die Seq selbst (`loadView`-Seq wird ignoriert), kürzt Snapshots nach
  `LIMITS.snapshotMaxChars` und prüft im Dev-/Testmodus jede Op mit `sessionOpSchema` (R0).
