# src/server/http – HTTP/WS-Schicht (WP-10)

Fastify-App, Konfiguration der Routen unter `/api/*` (auch der WebSocket-Endpunkt `/api/ws`, damit
der Vite-Dev-Proxy greift), Auth per Einmal-Code und HttpOnly-Cookie, Origin-/Host-/
`Sec-Fetch-Site`-Prüfung, CSP, statische Auslieferung von `dist/web`. Details: `docs/plan.md`,
Review A.8 und C.10.

- **Contract:** `@shared/http` (ADR-015) – `API_PATHS`, Request/Response-Schemas,
  `authCookieName(port)`, `allowedHosts`/`allowedOrigins`, Einmal-Code/Launcher-Token,
  Lockfile-Schema. Normativ: Endpunkt- und Prüftabelle, Client- und Launcher-Ablauf in
  `docs/architecture.md` §5.1.
- Module (Namen fest): `app.ts` (`createApp(deps)`), `auth.ts` (`POST /api/auth`,
  `GET /api/auth/status`, `POST /api/launcher/code`, Geräte-Cookie, `issueAuthCode(ttlMs?)`,
  Secret `PARALLAX_HOME/auth-secret.json`), `origin.ts` (Request-Prüfung nach der Tabelle §5.1).
- Fehlerkörper immer `ErrorPayload`, Status aus `ERROR_CATALOG`; nie CORS-Header; ein Code landet
  nur im Dev-Modus im Log (Dev-URL).
