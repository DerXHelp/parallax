# src/server/store – Persistenz (WP-10)

`JsonStore<T>` (zod-Schema, `schemaVersion`, Migrationen, atomar per Temp-Datei + Rename,
Retry bei EPERM/EBUSY, `.bak`, Quarantäne), Registry `sessions.json`, append-only
Transkript-Log `PARALLAX_HOME/entries/<id>/transcript.jsonl`. Alles unter `PARALLAX_HOME`
(Tests: Temp-Verzeichnis). Details: `docs/plan.md`, Review A.3 und B.
