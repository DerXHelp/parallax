# src/server/update – Update in der App (WP-87)

Auftrag und Entwurf: `docs/wp/WP-87.md`, Hintergrund `docs/wp/WP-83.md` §9. Der Dienst prüft auf neue Releases, bereitet
ein Update im Hintergrund vor und übergibt den Wechsel an den Orchestrator der alten Version (`launcher --apply-update`).

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `ports.ts` | `UpdateService` (Host-Befehle `update.*`, Zustand für `HostState.app`/`update`, Upload, Changelog, Hinweise) | Koordinator (eingefroren) |
| `endpoints.ts` | GitHub-Downloads und Release-Schlüssel; nur ein Test-Build (`__PARALLAX_UPDATE_TEST__`) liest lokale Endpunkte aus der Umgebung | Koordinator |
| `marker.ts` | `update-result.json` im Datenordner: Ergebnis eines Wechsels → `justUpdated`/`failedUpdate` | Koordinator |
| `handoff.ts` | Übergabe Server → Orchestrator: Flags, Handschlag-Zeilen, Fristen, `orchestratorCommand` | Koordinator |
| übrige Dateien | Dienst (`service.ts`), Prüfen, Laden, Entpacken, Vorbereiten, Routen | WP-87a |

Formate über Versionsgrenzen (`current.json`, `release.json`, `update-result.json`, Flags und Handschlag) ändern sich
nur additiv; ein Bruch braucht eine MAJOR-Version (WP-87 §1.7).
