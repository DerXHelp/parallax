# src/server – Node-Server (Fastify)

Einstieg: `main.ts` (wird nach `dist/server.js` gebündelt; `pnpm dev` startet ihn per `tsx watch`)
lädt Config und Logging und ruft `startServer()` aus `app/compose.ts` – die Kompositionswurzel,
die Stores, Backend, SessionManager, SyncHub, App, Shutdown-Rahmen und Lockfile in fester
Reihenfolge zusammensetzt (`docs/architecture.md` §3.3, Exit-Codes 0/1/3/4/5). Datei-genaue
Ownership: `docs/architecture.md` §2.1 (Phase 3: `CLAUDE.md` bzw. `docs/wp/WP-50.md` §6 – die Spalte
„Owner-WP“ nennt das anlegende Paket); diese README pflegt der Koordinator.

| Ordner/Datei | Inhalt | Owner-WP |
| --- | --- | --- |
| `**/ports.ts`, `backend/{types,fixture}.ts` | Server-Ports (eingefroren, nur per Contract-Änderung) | Koordinator |
| `lib/logger.ts`, `lib/ids.ts`, `lib/paths.ts` | Logger, `newId`, Pfad-Helfer (fs-Prüfungen auf `@shared/paths`) | 10 |
| `lib/process.ts` | `runFile` (Option `signal`), `spawnHidden`, `killProcessTree` (ohne Shell, `windowsHide`, nur absolute `.exe`), `powerShellPath` (einmal hier, R4-14) | 11 |
| `lib/windows.ts`, `lib/registry.ts`, `lib/chrome.ts` | PATH-Suche/npm-Shims, Registry (`reg.exe`), Chrome-Suche und -Version (R1-08, ADR-136) | 11, CHROME |
| `config.ts` | Config (`loadConfig`, Port-Default `DEFAULT_PORT` aus `@shared/model`), `isTestRun(env?)` – die eine Testlauf-Erkennung des Servers (Config, `system/run.ts`, `sync/hub.ts`, `store/transcripts.ts`; R4-14) | 10 |
| `http/`, `sync/`, `store/` | Fastify-App, Auth, Origin/Host, CSP, WS, Sync, Stores | 10 |
| `claude/` | `resolveClaude`, `buildEnv`, `parseProfileArgs`, Profil „Standard“, Preflight-Checks; CLI-Profil `cliProfile.ts` + `cli-profile.json` (WP-62, ADR-160) | 11, 62 |
| `sessions/normalizer/`, `sessions/status/` | Normalizer (zwei Adapter), Statusmaschine | 12 |
| übrige Dateien in `sessions/`, `backend/` | SessionManager, Broker, `FakeBackend`, `SdkBackend` | 13 |
| `main.ts`, `app/` | Einstieg, Komposition (`startServer`, `StartupError`), UI-Snapshot (`webSnapshot.ts`), Crash-Handler (`crash.ts`), Server-Integrationstest `main.integration.test.ts` | 20 |
| `launcher/` | Launcher, Lockfile, Chrome-Start (ADR-136), „Server beenden“; Paket-Modus (`release.json`, WP-85), Sicherung vor dem Start einer neuen Build-ID (`backupStep.ts`, WP-86) | 21, 85, 86 |
| `install/` | Installer `dist/install.js`: Prüfung, Versionsordner, Agent SDK, `start.mjs`/`parallax.cmd`, Aufräumen, `--use`, `--uninstall` (ADR-219) | 86 |
| `host/` | Phase 2: Host-Befehle ohne Session – Ordner-Browser `fs.listDirectory` (ADR-119) | 33 |
| `files/` | Phase 3: Datei-Dienst – Zugriffsrichtlinie (Wurzeln + Session-Index, ADR-141), `file.stat`/`statMany`, Inhalte für `GET /api/file` (ADR-142), Datei-Index `files.json` (ADR-145), Projektliste für den @-Picker (ADR-151), Editor-Erkennung und Programmstart (ADR-144); Port `files/ports.ts` eingefroren | 53 |
| `secure/` | Mehrere Rechner: TLS-Profil, Zertifikate, Pins, DPAPI-Schlüsselspeicher, Verbindungsbeweis (`docs/wp/WP-76.md` §B); Port `secure/ports.ts` eingefroren | 78 |
| `remote/` | Mehrere Rechner: Fernzugang des freigebenden Rechners – Listener, Kopplung, Peer, Verbindungsprotokoll (einzige Ausnahme vom Loopback, ADR-205); Port eingefroren | 78 |
| `multihost/` | Mehrere Rechner: Rolle aus/freigeben/steuern (`multi-host.json`, ADR-224); Port eingefroren | 78 |
| `hosts/` | Mehrere Rechner: Rechnerliste, Kopplung als Client, Vermittler, Wächter des steuernden Rechners; Port eingefroren | 79 |
| `system/` | Phase 2: Windows-Integration – externe Konsole (+ Fake-Konsole), Autostart-Verknüpfung, Protokoll-Handler `parallax:`, `createSystemIntegration` (Port `system/ports.ts` eingefroren); WP-86: Einträge einer Installation (`start.mjs`, Startmenü, Marker) | 33, 86 |
| `terminal/` | WP-97: „Shell im Ordner öffnen“ – cmd, PowerShell, Git Bash als Fenster im `cwd` (über die externe Konsole, neutrale Umgebung, Git-Suche; ADR-238); WP-99: eingebettetes Terminal | 97 |

Regeln: nie aus `src/web` importieren; Logging nur über `lib/logger.ts`; jeder Spawn über
`lib/process.ts` (`windowsHide: true`, ohne Shell, nur absolute `.exe`-Pfade – R1-04; einzige Ausnahme
`spawnGui`/`spawnExplorer` für sichtbare GUI-Programme nach Nutzerklick, ADR-144); Pfadregeln
nur aus `@shared/paths`; der Server lauscht nur auf `127.0.0.1` (R1-05) – einzige Ausnahme ist der Fernzugang (`remote/`, ab Werk aus, ADR-205).
