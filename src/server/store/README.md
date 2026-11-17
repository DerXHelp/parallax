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
| `blobs.ts` | `createBlobStore({ home, logger? })` → `BlobStore` (`put(data, mediaType, name?, size?)`) + `flush()`/`close()`, `blobFilePath`, `blobMetaPath` | `blobs/<blobId>`, `blobs/<blobId>.meta.json` (`blobRefSchema`, Phase 2 mit `width`/`height`) |
| `schemas.ts` | `STORE_SCHEMAS` (die eine Liste der Stores: Id, Bereich, Art, zod-Schema, `backup`), `schemaHash`, `storeSchemaHashes` – Schema-Hashes für `release.json` (WP-85, WP-83 §9.4), Liste für die Sicherung (WP-86; `backup: false` nur für `processes.json` und `auth-secret.json`, nicht im Hash); ein Test verlangt jedes Schema eines `new JsonStore` darin | – |
| `backup.ts` | `createBackup(home, { from, to, now?, fs? })` → `BackupResult`, `restoreBackup(home, dir, { fs? })` → `RestoreResult` (`restored`, `movedToNewer`, `truncated`, `warnings`), `pruneBackups(home, keep?, { now? })`, `readLastBuildId`/`writeLastBuildId`, `readBackupManifest`, `backupManifestSchema`, `listBackups(home)`/`findBackup(home, …)` (WP-87p: Sicherungen für „Zurück zu …“), `BackupError`, `BACKUPS_DIR`, `BACKUP_MANIFEST`, `BACKUPS_KEPT` (3), `LAST_VERSION_FILE`, `BACKUP_NEWER_DIR` – Sicherung beim Wechsel der Build-ID (WP-86, WP-83 §8.4) | `backups/<alt>-zu-<neu>-<zeit>/` (`backup.json`, Kopien, `newer/`), `last-version.json` |
| `attachments.ts` | `createAttachmentFileStore(home, blobs, { fs?, sizeOf? })` → `AttachmentFileStore`, `attachmentsDir`, `sanitizeAttachmentName`, `ATTACHMENTS_DIR`, `ATTACHMENT_NAME_MAX` (120) | `entries/<entryId>/attachments/<blobId[0..16]>/<Name>` (Phase 3, ADR-146) |

Weitere Dateien über `JsonStore`, aber außerhalb dieses Ordners: `auth-secret.json`
(`http/auth.ts`, `backup: false`), `processes.json` (`sessions/processStore.ts`, WP-13),
`entries/<entryId>/files.json` (`files/sessionIndex.ts`, Phase 3). Das
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
Speicher. Eine Meta je Inhalt: die erste gewinnt, außer ein späteres `put` bringt eine bessere (CR2-07,
ADR-134): den per Magic Bytes bestätigten Bildtyp statt eines anderen gespeicherten Typs (z. B.
`application/octet-stream` vom Normalizer) oder – als Upload, das einzige `put` mit Pixelgröße – einen
anderen Namen/eine andere Größe dieses Typs (der letzte Upload gewinnt). Geprüft gegen den Ref im Speicher
und erneut gegen die Meta-Datei (auch nach einem Neustart); Schreibvorgänge eines Inhalts laufen
nacheinander, eine ungültige Meta-Datei wird ersetzt. Leerer/zu langer Medientyp →
`application/octet-stream`, langer Name wird gekürzt (`put` wirft nie, R1-20). Phase 2 (ADR-103,
WP-33): `put(…, size)` speichert die Pixelgröße eines hochgeladenen Bildes (`width`/`height`);
nur ein vollständiges Paar positiver Ganzzahlen, sonst `null`.

Phase 3 (WP-53): auch ein per `%PDF-` bestätigtes `application/pdf` zählt als bestätigter Typ
(ein hochgeladenes PDF ersetzt z. B. eine `application/octet-stream`-Meta derselben Bytes).

**Anhänge (Phase 3, ADR-146, WP-53):** `dir(entryId)` legt `entries/<entryId>/attachments` bei Bedarf
an (die Engine gibt ihn jedem Start als `additionalDirectory`). `materialize(entryId, blobId, name)`
kopiert den Blob nach `<dir>\<blobId[0..16]>\<Name>`: Name bereinigt (`sanitizeAttachmentName`: nur
das letzte Segment, verbotene Zeichen und Steuerzeichen → `_`, Punkt/Leerzeichen am Ende weg,
reservierte Gerätenamen mit `_`-Präfix, ≤ 120 Zeichen mit Endung; die Regeln selbst kommen aus
`@shared/paths`), sonst `<blob16>.<ext>`; idempotent (gleiche Größe vorhanden → nichts tun), atomar
(`writeFileAtomic`), `BLOB_NOT_FOUND` bei fehlendem Blob. Der Datei-Dienst behandelt den Ordner als
Wurzel und listet seine Dateien als `attached`.

**Sicherung beim Wechsel der Build-ID (WP-86, WP-83 §8.4):** Der Launcher (nicht `pnpm dev`) vergleicht
die Build-ID mit `last-version.json` und ruft vor dem Serverstart `createBackup` auf. Gesichert wird nach
der Liste `STORE_SCHEMAS` (`backup: true`): jede vorhandene Datei der JSON-Stores im Datenordner und je
Eintrag (`entries/<id>/…`) samt `.bak`; von den Transkripten nur die Länge in Bytes (`backup.json`). Nicht
gesichert: `processes.json`, `auth-secret.json`, `blobs/`, Anhänge, Pläne, `ui/`, `chrome/`, `logs/`,
Quarantäne- und Temp-Dateien, frühere Sicherungen. Ordner `backups/<alt|unbekannt>-zu-<neu>-<YYYYMMDD-HHmmss>`
(Zeit in UTC; Zeichen außer `A-Z a-z 0-9 . _ + -` werden `_`; gleiche Sekunde → `-2`), erst als
`backups/.partial-…` geschrieben, dann umbenannt. `restoreBackup` (Rückweg, WP-87) prüft zuerst
`backup.json` (zod, nur Pfade der Liste) und jede gesicherte Datei – sonst `BackupError`, nichts geändert –,
schreibt dann die Dateien atomar zurück (ohne `.bak` der ersetzten Datei), verschiebt Store-Dateien und
Transkripte, die nicht in der Sicherung sind, nach `<sicherung>/newer/` (vorhanden → Endung `.1`, `.2`, …)
und kürzt Transkripte auf die gesicherte Länge; kürzere oder fehlende Transkripte bleiben und stehen in
`warnings`. `pruneBackups` behält die drei jüngsten (nach `createdAt`, unlesbare zählen als älteste) und
löscht `.partial-*` älter als eine Stunde.

**`settings.json` nur lesend:** `config.ts` (`readSettingsFile`) liest die Datei für Port und
Autostart-Fenster vor dem Start (Launcher, ADR-111) – ohne zu schreiben, zu verschieben oder zu
migrieren; geschrieben wird sie nur über `openSettingsStore`.

**Warnungen:** `createStoreWarnings()` ist `StoreWarnings` (Port) und Sink für alle Stores;
`onChange` meldet neue Warnungen (die Engine veröffentlicht dann `host.state`).
