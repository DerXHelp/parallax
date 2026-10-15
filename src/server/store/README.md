# src/server/store – Persistenz (WP-10)

Alles unter `PARALLAX_HOME` (Tests: Temp-Verzeichnis). Layout: `docs/architecture.md` §8;
Store-Ports stehen in `src/server/sync/ports.ts`.

| Datei | Exporte | Datei unter `PARALLAX_HOME` |
| --- | --- | --- |
| `jsonStore.ts` | `JsonStore<T>` (`JsonStoreOptions`, `Migrations`, `Versioned`), `createStoreWarnings()` → `StoreWarningRegistry` (`StoreWarningSink`), `StoreVersionTooNewError`, `STORE_VERSION_TOO_NEW_EXIT_CODE` (3), `fileTimestamp`; Re-Exporte aus `lib/fs.ts` (R2-10, ADR-055): `writeFileAtomic`, `withFsRetry`, `DEFAULT_RETRY_DELAYS_MS`, `StoreFs`/`nodeStoreFs` (= `FsOps`/`nodeFsOps`, Test-Naht) | – |
| `registry.ts` | `openRegistryStore({ home, warnings?, debounceMs?, fs?, retryDelaysMs?, logger? })` → `RegistryStore` + `close()`, `REGISTRY_FILE`, `REGISTRY_MIGRATIONS` | `sessions.json` |
| `settings.ts` | `openSettingsStore({ home, warnings?, … })` → `SettingsStore` + `flush()`/`close()`, `SETTINGS_FILE`, `SETTINGS_MIGRATIONS` | `settings.json` |
| `decisions.ts` | `createDecisionStore({ home, warnings?, … })` → `DecisionStore` + `flush()`/`close()`, `entryDir`, `planPath`, `ENTRIES_DIR`, `DECISIONS_FILE` | `entries/<entryId>/decisions.json`, `entries/<entryId>/plans/v<N>.md` |
| `transcripts.ts` | `createTranscriptStore({ home, validation?, warnings?, flushMs?, cacheSize?, logger? })` → `TranscriptStore` + `stats()`/`close()`, `transcriptPath`, `isStreamingItem`, `TranscriptValidation`, `TRANSCRIPT_FAILURES_BEFORE_WARNING` | `entries/<entryId>/<conversationId>.transcript.jsonl` |
| `blobs.ts` | `createBlobStore({ home, logger? })` → `BlobStore` + `flush()`/`close()`, `blobFilePath`, `blobMetaPath` | `blobs/<blobId>`, `blobs/<blobId>.meta.json` (`blobRefSchema`) |

Weitere Dateien über `JsonStore`, aber außerhalb dieses Ordners: `auth-secret.json`
(`http/auth.ts`, `backup: false`), `processes.json` (`sessions/processStore.ts`, WP-13). Das
Lockfile `server.lock.json` (`launcher/lockFile.ts`) nutzt nur `writeFileAtomic`/`withFsRetry` aus
`lib/fs.ts`. Neue Nutzer außerhalb von `store/` importieren diese Helfer direkt aus `lib/fs.ts`
(ADR-055), nicht über `jsonStore.ts`.

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
bleibt gesperrt (`get`/`set` werfen). WP-20 bricht den Start damit ab (`app/compose.ts` →
`StartupError`, Exit `SERVER_EXIT_CODES.storeVersionTooNew` = `STORE_VERSION_TOO_NEW_EXIT_CODE` = 3).

**Transkript-Log:** gepufferter Writer je Datei (50 ms), nicht-streamende Items nur
(streamende werden verworfen und gezählt), Laden = Falten nach `id` (letzte Zeile gewinnt),
sortiert nach `order`, defekte Zeilen übersprungen und gezählt, abgebrochene letzte Zeile wird
vor dem nächsten Anhängen abgeschlossen; LRU-Cache (8 Unterhaltungen), beim Anhängen
aktualisiert. IDs werden vor jedem Pfadbau validiert (kein Path-Traversal). `validation`
(Modul-Default `throw` unter Vitest/`NODE_ENV=test`, sonst `off`; der Server übergibt
`config.validation`, Default `log` auch im Prod-Betrieb – R3-05) prüft jede angehängte Zeile
gegen `transcriptLogLineSchema` (`log`: verworfen, `stats().invalidLines` gezählt, gedrosselt
geloggt); nach 3 fehlgeschlagenen Schreibversuchen einer Datei gibt es
einmal `STORE_WRITE_FAILED` an `warnings` (R1-16).

**Blobs:** `put` hasht synchron (SHA-256) und schreibt asynchron; bis dahin liefert `get` aus dem
Speicher; die erste Meta-Datei eines Inhalts gewinnt. Leerer/zu langer Medientyp →
`application/octet-stream`, langer Name wird gekürzt (`put` wirft nie, R1-20).

**Warnungen:** `createStoreWarnings()` ist `StoreWarnings` (Port) und Sink für alle Stores;
`onChange` meldet neue Warnungen (die Engine veröffentlicht dann `host.state`).
