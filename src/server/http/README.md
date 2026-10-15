# src/server/http – HTTP/WS-Schicht (WP-10)

Fastify-App, alle Routen unter `/api/*` (auch der WebSocket-Endpunkt `/api/ws`, damit der
Vite-Dev-Proxy greift), Auth per Einmal-Code und HttpOnly-Cookie, Origin-/Host-/
`Sec-Fetch-Site`-Prüfung, Security-Header/CSP, statische Auslieferung von `dist/web`.

- **Contract:** `@shared/http` (ADR-015) – `API_PATHS`, Request/Response-Schemas,
  `authCookieName(port)`, `allowedHosts`/`allowedOrigins`, Einmal-Code/Launcher-Token,
  Lockfile-Schema. Normativ: Endpunkt- und Prüftabelle, Client- und Launcher-Ablauf in
  `docs/architecture.md` §5.1.
- Fehlerkörper immer `ErrorPayload`, Status aus `ERROR_CATALOG`; nie CORS-Header; ein Code landet
  nur im Dev-Modus im Log (Dev-URL).

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `app.ts` | `createApp(options)`, `AttachableHub`, `pageCsp(port)`, `BLOB_CSP`, `safeMediaType` | App: Guard-Hook (auch für den WS-Upgrade), Security-Header, Error-/404-Handler, `/api/health`, Blob-Route, `/api/attachments` (Phase 1: 501), `@fastify/websocket` (`maxPayload`), `hub.attach(app)`, Static, Dev-Login-URL beim `listen` |
| `auth.ts` | `createAuthService(options) → AuthService`, `registerAuthRoutes`, `authCookieHeader`, `readCookie`, `AUTH_SECRET_FILE` | Einmal-Codes (`issueAuthCode(ttlMs?)`, `exchangeCode`), Geräte-Cookie (HMAC, Secret `PARALLAX_HOME/auth-secret.json`, `rotateSecret`, `onRevoked`), Launcher-Token (`launcherToken`, `verifyLauncherToken`); Routen `POST /api/auth`, `GET /api/auth/status`, `POST /api/launcher/code` |
| `origin.ts` | `checkRequest`, `classifyRequest`, `requestPath` | reine Request-Prüfung nach der Tabelle §5.1 (`needsCookie` prüft der Aufrufer) |
| `reply.ts` | `sendError`, `replyError` | HTTP-Fehlerantwort mit Katalog-Status |
| `testServer.ts` | `startTestServer`, `connectWs`, `connectAndHello`, `rawRequest`, `TestWsClient`, `makeTempHome` | **nur Tests**: echter Server auf Port 0, Temp-Home, Memory-Source, `ws`-Client |

Verdrahtung (WP-20, `main.ts`):

```ts
const config = loadConfig();
const logging = await initLogging({ home: config.home, dev: config.dev, level: config.logLevel });
const instance = createServerInstance();
const warnings = createStoreWarnings();
const auth = await createAuthService({ home: config.home, serverInstanceId: instance.serverInstanceId, warnings });
const blobs = createBlobStore({ home: config.home });
const hub = createSyncHub({ source: engine, instance, validation: config.dev ? 'log' : 'off' });
const app = await createApp({ config, instance, auth, blobs, hub, webRoot });
await app.listen({ host: config.host, port: config.port });
// WP-21: server.lock.json mit auth.launcherToken; erster Start: auth.issueAuthCode()
```
