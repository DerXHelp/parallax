# src/server/store – Persistenz (WP-10)

Alles unter `PARALLAX_HOME` (Tests: Temp-Verzeichnis). Layout: `docs/architecture.md` §8;
Store-Ports stehen in `src/server/sync/ports.ts`.

| Datei | Exporte | Datei unter `PARALLAX_HOME` |
| --- | --- | --- |
| `jsonStore.ts` | `JsonStore<T>`, `createStoreWarnings()`, `writeFileAtomic`, `withFsRetry`, `nodeStoreFs`/`StoreFs` (Test-Naht) | – |
| `registry.ts` | `openRegistryStore({ home, warnings? })` → `RegistryStore` + `close()` | `sessions.json` |
| `settings.ts` | `openSettingsStore({ home, warnings? })` → `SettingsStore` + `flush()`/`close()` | `settings.json` |
| `decisions.ts` | `createDecisionStore({ home, warnings? })` → `DecisionStore` + `flush()`/`close()`, `entryDir`, `planPath` | `entries/<entryId>/decisions.json`, `entries/<entryId>/plans/v<N>.md` |
| `transcripts.ts` | `createTranscriptStore({ home })` → `TranscriptStore` + `stats()`/`close()`, `transcriptPath`, `isStreamingItem` | `entries/<entryId>/<conversationId>.transcript.jsonl` |
| `blobs.ts` | `createBlobStore({ home })` → `BlobStore` + `flush()`/`close()`, `blobFilePath`, `blobMetaPath` | `blobs/<blobId>`, `blobs/<blobId>.meta.json` (`blobRefSchema`) |

**JsonStore** (B „Persistenz“): zod-Schema der ganzen Datei + `schemaVersion` + Migrationen
(`migrations[n]`: Version n → n + 1); atomar über Temp-Datei (fsync) + Rename, Retry bei
EPERM/EBUSY/EACCES; vor jedem Schreiben `.bak` = vorige Fassung (abschaltbar: `backup: false`,
z. B. `auth-secret.json`, R1-11); korrupte/ungültige Dateien → Quarantäne
`<datei>.corrupt-<zeit>-<rand>` + Host-Warnung `STORE_CORRUPT_QUARANTINED` (Migrationsfehler:
`STORE_MIGRATION_FAILED`), dann `.bak`, sonst Defaults; Schreibfehler → `STORE_WRITE_FAILED`,
Daten bleiben im Speicher. Ein Writer je Datei, Debounce (Default 200 ms). `set()` validiert (wirft
bei ungültigen Daten). Geschrieben wird erst, nachdem die Datei gelesen wurde.

**Neuere `schemaVersion` (R1-06, ADR-020):** Datei (oder `.bak`) einer neueren Parallax-Version →
`load()` (und damit `openRegistryStore`/`openSettingsStore`/…) verwirft mit
`StoreVersionTooNewError` (`STORE_VERSION_TOO_NEW {file, version, supported}`, englische Meldung
„… update Parallax“); die Datei wird **nicht** verschoben, migriert oder überschrieben, der Store
bleibt gesperrt (`get`/`set` werfen). WP-20 bricht den Start damit ab
(`STORE_VERSION_TOO_NEW_EXIT_CODE` = 3).

**Transkript-Log:** gepufferter Writer je Datei (50 ms), nicht-streamende Items nur
(streamende werden verworfen und gezählt), Laden = Falten nach `id` (letzte Zeile gewinnt),
sortiert nach `order`, defekte Zeilen übersprungen und gezählt, abgebrochene letzte Zeile wird
vor dem nächsten Anhängen abgeschlossen; LRU-Cache (8 Unterhaltungen), beim Anhängen
aktualisiert. IDs werden vor jedem Pfadbau validiert (kein Path-Traversal). `validation`
(`throw` unter Vitest, `log` im Dev-Modus über WP-20, sonst `off`) prüft jede angehängte Zeile
gegen `transcriptLogLineSchema`; nach 3 fehlgeschlagenen Schreibversuchen einer Datei gibt es
einmal `STORE_WRITE_FAILED` an `warnings` (R1-16).

**Blobs:** `put` hasht synchron (SHA-256) und schreibt asynchron; bis dahin liefert `get` aus dem
Speicher; die erste Meta-Datei eines Inhalts gewinnt. Leerer/zu langer Medientyp →
`application/octet-stream`, langer Name wird gekürzt (`put` wirft nie, R1-20).

**Warnungen:** `createStoreWarnings()` ist `StoreWarnings` (Port) und Sink für alle Stores;
`onChange` meldet neue Warnungen (die Engine veröffentlicht dann `host.state`).
