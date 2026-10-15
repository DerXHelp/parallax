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
EPERM/EBUSY/EACCES; vor jedem Schreiben `.bak` = vorige Fassung; korrupte/ungültige Dateien →
Quarantäne `<datei>.corrupt-<zeit>-<rand>` + Host-Warnung `STORE_CORRUPT_QUARANTINED`
(Migrationsfehler/neuere Version: `STORE_MIGRATION_FAILED`), dann `.bak`, sonst Defaults;
Schreibfehler → `STORE_WRITE_FAILED`, Daten bleiben im Speicher. Ein Writer je Datei, Debounce
(Default 200 ms). `set()` validiert (wirft bei ungültigen Daten).

**Transkript-Log:** gepufferter Writer je Datei (50 ms), nicht-streamende Items nur
(streamende werden verworfen und gezählt), Laden = Falten nach `id` (letzte Zeile gewinnt),
sortiert nach `order`, defekte Zeilen übersprungen und gezählt, abgebrochene letzte Zeile wird
vor dem nächsten Anhängen abgeschlossen; LRU-Cache (8 Unterhaltungen), beim Anhängen
aktualisiert. IDs werden vor jedem Pfadbau validiert (kein Path-Traversal).

**Blobs:** `put` hasht synchron (SHA-256) und schreibt asynchron; bis dahin liefert `get` aus dem
Speicher; die erste Meta-Datei eines Inhalts gewinnt.

**Warnungen:** `createStoreWarnings()` ist `StoreWarnings` (Port) und Sink für alle Stores;
`onChange` meldet neue Warnungen (die Engine veröffentlicht dann `host.state`).
