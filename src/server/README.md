# src/server – Node-Server (Fastify)

Einstieg: `main.ts` (wird nach `dist/server.js` gebündelt; `pnpm dev` startet ihn per `tsx watch`)
lädt Config und Logging und ruft `startServer()` aus `app/compose.ts` – die Kompositionswurzel,
die Stores, Backend, SessionManager, SyncHub, App, Shutdown-Rahmen und Lockfile in fester
Reihenfolge zusammensetzt (`docs/architecture.md` §3.3, Exit-Codes 0/1/3/4/5). Datei-genaue
Ownership: `docs/architecture.md` §2.1 (Phase 2: `CLAUDE.md` bzw. `docs/wp/WP-30.md` §6 – die Spalte
„Owner-WP“ nennt das anlegende Paket); diese README pflegt der Koordinator.

| Ordner/Datei | Inhalt | Owner-WP |
| --- | --- | --- |
| `**/ports.ts`, `backend/{types,fixture}.ts` | Server-Ports (eingefroren, nur per Contract-Änderung) | Koordinator |
| `lib/logger.ts`, `lib/ids.ts`, `lib/paths.ts` | Logger, `newId`, Pfad-Helfer (fs-Prüfungen auf `@shared/paths`) | 10 |
| `lib/process.ts` | `runFile`, `spawnHidden`, `killProcessTree` (ohne Shell, `windowsHide`, nur absolute `.exe`) | 11 |
| `lib/windows.ts`, `lib/registry.ts`, `lib/edge.ts` | PATH-Suche/npm-Shims, Registry (`reg.exe`), Edge-Suche (R1-08) | 11 |
| `config.ts`, `http/`, `sync/`, `store/` | Config, Fastify-App, Auth, Origin/Host, CSP, WS, Sync, Stores | 10 |
| `claude/` | `resolveClaude`, `buildEnv`, `parseProfileArgs`, Profil „Standard“, Preflight-Checks | 11 |
| `sessions/normalizer/`, `sessions/status/` | Normalizer (zwei Adapter), Statusmaschine | 12 |
| übrige Dateien in `sessions/`, `backend/` | SessionManager, Broker, `FakeBackend`, `SdkBackend` | 13 |
| `main.ts`, `app/` | Einstieg, Komposition (`startServer`, `StartupError`), UI-Snapshot (`webSnapshot.ts`), Crash-Handler (`crash.ts`), Server-Integrationstest `main.integration.test.ts` | 20 |
| `launcher/` | Launcher, Lockfile, Edge-Start, „Server beenden“ | 21 |
| `host/` | Phase 2: Host-Befehle ohne Session – Ordner-Browser `fs.listDirectory` (ADR-119) | 33 |
| `system/` | Phase 2: Windows-Integration – externe Konsole (+ Fake-Konsole), Autostart-Verknüpfung, Protokoll-Handler `parallax:`, `createSystemIntegration` (Port `system/ports.ts` eingefroren) | 33 |

Regeln: nie aus `src/web` importieren; Logging nur über `lib/logger.ts`; jeder Spawn über
`lib/process.ts` (`windowsHide: true`, ohne Shell, nur absolute `.exe`-Pfade – R1-04); Pfadregeln
nur aus `@shared/paths`; der Server lauscht nur auf `127.0.0.1` (R1-05).
