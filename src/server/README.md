# src/server – Node-Server (Fastify)

Einstieg: `main.ts` (wird nach `dist/server.js` gebündelt). `bootstrap.ts` ist ein temporärer
Stub aus WP-00 und wird in WP-20 durch die echte Verdrahtung ersetzt.

| Ordner      | Inhalt                                                                  | Owner-WP    |
| ----------- | ----------------------------------------------------------------------- | ----------- |
| `lib/`      | Generische Helfer (Logger, Pfad-Helfer, Prozesse/taskkill, Spawn)       | 10, 11      |
| `http/`     | Fastify-App, Auth (Cookie), Origin/Host-Prüfung, CSP, Routen, WS-Upgrade | 10          |
| `sync/`     | Sync-Protokoll: Seq, Ringpuffer, subscribe/ack, Resync                  | 10          |
| `store/`    | `JsonStore<T>`, Registry `sessions.json`, Transkript-Log                 | 10          |
| `claude/`   | `resolveClaude`, `buildEnv`, Profil „Standard“, Preflight-Checks        | 11          |
| `sessions/` | Normalizer + Statusmaschine (WP-12), SessionManager + Broker (WP-13)   | 12, 13      |
| `backend/`  | `AgentBackend`-Implementierungen: `FakeBackend`, `SdkBackend`           | 13          |

Regeln: nie aus `src/web` importieren; Logging nur über `lib/logger.ts`; jeder Spawn mit
`windowsHide: true` und ohne Shell.
