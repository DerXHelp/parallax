# src/server – Node-Server (Fastify)

Einstieg: `main.ts` (wird nach `dist/server.js` gebündelt). `bootstrap.ts` ist ein temporärer
Stub aus WP-00 und wird in WP-20 durch die echte Verdrahtung ersetzt. Datei-genaue Ownership:
`docs/architecture.md` §2.1; diese README pflegt der Koordinator.

| Ordner/Datei | Inhalt | Owner-WP |
| --- | --- | --- |
| `**/ports.ts`, `backend/{types,fixture}.ts` | Server-Ports (eingefroren, nur per Contract-Änderung) | Koordinator |
| `lib/logger.ts`, `lib/ids.ts`, `lib/paths.ts` | Logger, `newId`, Pfad-Helfer (fs-Prüfungen auf `@shared/paths`) | 10 |
| `lib/process.ts` | `runFile`, `spawnHidden`, `killProcessTree` (ohne Shell, `windowsHide`) | 11 |
| `config.ts`, `http/`, `sync/`, `store/` | Config, Fastify-App, Auth, Origin/Host, CSP, WS, Sync, Stores | 10 |
| `claude/` | `resolveClaude`, `buildEnv`, `parseProfileArgs`, Profil „Standard“, Preflight-Checks | 11 |
| `sessions/normalizer/`, `sessions/status/` | Normalizer (zwei Adapter), Statusmaschine | 12 |
| übrige Dateien in `sessions/`, `backend/` | SessionManager, Broker, `FakeBackend`, `SdkBackend` | 13 |
| `main.ts`, `bootstrap.ts` | Einstieg, Verdrahtung | 20 |
| `launcher/` | Launcher, Lockfile, Edge-Start, „Server beenden“ | 21 |

Regeln: nie aus `src/web` importieren; Logging nur über `lib/logger.ts`; jeder Spawn über
`lib/process.ts` (`windowsHide: true`, ohne Shell); Pfadregeln nur aus `@shared/paths`.
