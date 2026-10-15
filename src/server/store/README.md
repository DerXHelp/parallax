# src/server/store – Persistenz (WP-10)

`JsonStore<T>` (zod-Schema, `schemaVersion`, Migrationen, atomar per Temp-Datei + Rename,
Retry bei EPERM/EBUSY, `.bak`, Quarantäne), Registry `sessions.json`, append-only
Transkript-Log `PARALLAX_HOME/entries/<entryId>/<conversationId>.transcript.jsonl`
(`transcriptLogLineSchema`), Blobs `blobs/<blobId>` mit Meta-Datei `blobs/<blobId>.meta.json`
(`blobRefSchema`), `entries/<entryId>/decisions.json` (offene Records mit `decision`-Snapshot,
R0-07), Pläne `entries/<entryId>/plans/v<N>.md`. Alles unter `PARALLAX_HOME` (Tests:
Temp-Verzeichnis). Layout: `docs/architecture.md` §8; Details: `docs/plan.md`, Review A.3 und B.
Store-Ports stehen in `src/server/sync/ports.ts`.
