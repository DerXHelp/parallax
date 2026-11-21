# src/server/update – Update in der App (WP-87)

Auftrag und Entwurf: `docs/wp/WP-87.md`, Hintergrund `docs/wp/WP-83.md` §9. Der Dienst prüft auf neue Releases, bereitet
ein Update im Hintergrund vor und übergibt den Wechsel an den Orchestrator der alten Version (`launcher --apply-update`).

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `ports.ts` | `UpdateService` (Host-Befehle `update.*`, Zustand für `HostState.app`/`update`, Upload, Changelog, Hinweise) | Koordinator (eingefroren) |
| `endpoints.ts` | GitHub-Downloads und Release-Schlüssel; nur ein Test-Build (`__PARALLAX_UPDATE_TEST__`) liest lokale Endpunkte aus der Umgebung | Koordinator |
| `marker.ts` | `update-result.json` im Datenordner: Ergebnis eines Wechsels → `justUpdated`/`failedUpdate` | Koordinator |
| `handoff.ts` | Übergabe Server → Orchestrator: Flags, Handschlag-Zeilen, Fristen, `orchestratorCommand` | Koordinator |
| `service.ts` | `createUpdateService` (async): Zustand, Zeitplan, Befehle, Upload-Annahme, „Was ist neu“, Hinweise | WP-87a |
| `fetch.ts` / `latest.ts` | Abrufe mit Weiterleitungs- und Größenregeln; `latest.json` + Signatur + Changelog | WP-87a |
| `zip.ts` / `prepare.ts` | Archiv prüfen und entpacken (`tar.exe` bzw. unter Linux GNU `tar -z`); Vorbereiten unter der Sperre `install`; ein zu altes Node nach `minNode` von `latest.json` scheitert vor Sperre und Download (ADR-232) | WP-87a, WP-108 |
| `previous.ts` / `changelog.ts` / `notices.ts` / `stateFile.ts` | vorige Version; Changelog-Abschnitte; feste Textdateien; `update-state.json` | WP-87a |
| `apply.ts` | Orchestrator starten, Handschlag (Frist; bei Stille oder unlesbarer Zeile beendet) | WP-87a |
| `routes.ts` | `POST /api/update/package`, `GET /api/changelog`, `GET /api/notices` | WP-87a |
| `testing.ts` / `testRelease.ts` | Fake-Dienst; Test-Hilfen (Release-Server, Archive je Plattform: `archiveFolders`, `archivePath`) – nur für Tests | WP-87a, WP-108 |

Formate über Versionsgrenzen (`current.json`, `release.json`, `update-result.json`, Flags und Handschlag) ändern sich
nur additiv; ein Bruch braucht eine MAJOR-Version (WP-87 §1.7).

## Je Plattform (WP-108)

- **Assets:** `parallax-<v>-win.zip` und `parallax-<v>-linux-x64.tar.gz` aus demselben signierten Ordner
  (`releaseAssetName`, `releaseTarget()`: Windows jede Architektur, Linux nur x64, sonst kein Update). Die Endpunkte
  kennen das Ziel des Hosts (`target`); `assetUrl(version)` nennt dessen Asset.
- **`latest.json`:** oben weiter das Windows-Zip (das lesen alle älteren Versionen), dazu `assets` mit jedem Asset
  (optional, ältere Leser ignorieren es). `checkLatest` prüft die obere URL, wählt das Asset des Hosts
  (`releaseAssetOf`/`latestForTarget`) und reicht `latest` mit dessen URL, Größe und Hash weiter; ohne Asset für den
  Host: kein Update (`platform`).
- **Archiv:** `zip.ts` `archiveTool()` – bsdtar (`tar.exe`, Zip) unter Windows, GNU tar (`-z`, `--numeric-owner`,
  entpackt ohne Besitzer und Modus des Archivs) unter Linux; `parseZipListing(…, style)` liest beide Listenformate,
  eine unbekannte Zeile macht das Paket ungültig. Ein Upload („Aus Datei“) landet als `.zip` bzw. `.tar.gz`.
