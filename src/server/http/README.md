# src/server/http – HTTP/WS-Schicht (WP-10, Phase 2: WP-33)

Fastify-App, alle Routen unter `/api/*` (auch der WebSocket-Endpunkt `/api/ws`, damit der
Vite-Dev-Proxy greift), Auth per Einmal-Code und HttpOnly-Cookie, Origin-/Host-/
`Sec-Fetch-Site`-Prüfung, Security-Header/CSP, statische Auslieferung von `dist/web`.

- **Contract:** `@shared/http` (ADR-015) – `API_PATHS`, Request/Response-Schemas,
  `authCookieName(port)`, `allowedHosts`/`allowedOrigins`, Einmal-Code/Launcher-Token,
  Lockfile-Schema. Normativ: Endpunkt- und Prüftabelle, Client- und Launcher-Ablauf in
  `docs/architecture.md` §5.1.
- Fehlerkörper immer `ErrorPayload`, Status aus `ERROR_CATALOG`; nie CORS-Header; ein Code landet
  nur im Dev-Modus im Log (Dev-URL).
- **Guard (R1-01, ADR-018):** klassifiziert nach der **gematchten Route**
  (`request.routeOptions.url`), nie nach dem URL-Text; Default-deny (nicht gelistete Routen =
  `mutation`); Request-Target muss Origin-Form haben, API-Pfade kanonisch (kein `%`, `.`, `;`,
  `//`, `/` am Ende); WS-Upgrades nur auf `/api/ws`; die WS-Route prüft das Upgrade zusätzlich
  selbst (`preValidation` + WS-Handler, `HubAttachOptions.authorizeUpgrade`). WS-Upgrade:
  `Sec-Fetch-Site` nur, falls vorhanden (V1-01, ADR-019).

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `app.ts` | `createApp(options)`, `AttachableHub`, `HubAttachOptions`, `safeMediaType`, `mediaTypeEssence`, `contentPolicyHeaders`, `isPdfBlob`, `inlineDisposition`, `UPLOAD_BODY_LIMIT_BYTES` | App: Guard-Hook (auch für den WS-Upgrade), Security-Header (CSP aus `@shared/http`: `pageCsp(port)`, `BLOB_CSP`, `FILE_PDF_CSP`, R3-14; `X-Frame-Options` `DENY`, außer eine Route setzt `SAMEORIGIN`), Error-/404-Handler (`ROUTE_NOT_FOUND`), `/api/health` (mit `backend`, wenn `config.backend` gesetzt ist, R3-02), Blob-Route (PDF-Header-Satz, Phase 3), `GET`/`HEAD /api/file` (Phase 3, unten), Upload `/api/attachments` (unten), `@fastify/websocket` (`maxPayload`), `hub.attach(app, { authorizeUpgrade })`, Static, Dev-Login-URL beim `listen` |
| `upload.test.ts` | – | Upload per `app.inject`: Bilder (Name, Pixelgröße in der Meta-Datei), PDFs, andere Dateien (mit/ohne `name`), Bild-Bytes als octet-stream bleiben Datei (CR3-03), Größen je Typ, 415 Typ/Magic-Bytes, abweichender Bildtyp → erkannter Typ (CR2-08), 400 Query, 401 ohne Cookie, 403 fremder Origin |
| `file.test.ts` | – | `GET`/`HEAD /api/file`: Guard-Matrix `Sec-Fetch-Site` × `Origin` × Cookie, Header-Sätze Text/Bild/SVG/PDF, `filename*`, Fehlerstatus, kein Dateiinhalt im Log, Blob-PDF-Header, Ende-zu-Ende mit dem echten Datei-Dienst |
| `auth.ts` | `createAuthService(options) → AuthService`, `registerAuthRoutes`, `authCookieHeader`, `readCookie`, `AUTH_SECRET_FILE` | Einmal-Codes (`issueAuthCode(ttlMs?)`, `exchangeCode`), Geräte-Cookie (HMAC, Secret `PARALLAX_HOME/auth-secret.json` ohne `.bak`, `rotateSecret`, `onRevoked`), Launcher-Token (`launcherToken`, `verifyLauncherToken`); Routen `POST /api/auth`, `GET /api/auth/status`, `POST /api/launcher/code` |
| `origin.ts` | `checkRequest`, `classifyRequest`, `isApiRoute`, `requestPath`, `STATIC_ROUTE` | reine Request-Prüfung nach der Tabelle §5.1 (Routen-Muster statt Pfad; `needsCookie` prüft der Aufrufer); Phase 3: Klasse `file` (`Sec-Fetch-Site` Pflicht `same-origin`, `Origin` falls vorhanden erlaubt, Cookie) |
| `reply.ts` | `sendError`, `replyError` | HTTP-Fehlerantwort mit Katalog-Status |
| `testServer.ts` | `startTestServer`, `connectWs`, `connectAndHello`, `rawRequest`, `rawUpgrade`, `TestWsClient`, `makeTempHome` | **nur Tests**: echter Server auf Port 0, Temp-Home, Memory-Source, optional `webRoot`, `ws`-Client (ohne `Sec-Fetch-Site` wie Edge/Chrome), roher Upgrade über `net` |

**Bild-Upload (Phase 2, ADR-103):** `POST /api/attachments?name=…&width=…&height=…`, Guard-Klasse
„mutation“ (Origin, `same-origin`, Cookie – unverändert, Default-deny). Rohbytes; Content-Type-Parser
nur für `ATTACHMENT_MEDIA_TYPES` (Buffer, `bodyLimit = LIMITS.imageBytes`) – anderer Typ 415
`UNSUPPORTED_MEDIA_TYPE`, zu groß 413 `PAYLOAD_TOO_LARGE` (beides über den Error-Handler); Query per
`attachmentUploadQuerySchema` (400 `VALIDATION_FAILED {reason: 'query'}`); die Magic-Bytes
(`lib/images.ts` `sniffImageType`) müssen einen Bildtyp der API zeigen, sonst 415 (auch leerer Körper);
weicht der deklarierte Bildtyp davon ab (umbenannte Datei), gilt der erkannte (CR2-08, ADR-134).
Dann `blobs.put(data, <erkannter Typ>, name ?? null, {width, height} | null)` → 200
`attachmentUploadResponseSchema` `{attachment: BlobRef}` (inhaltsadressiert; liegen die Bytes schon mit anderer Meta im Store, liefert und speichert der Upload seinen erkannten Typ und – mit `width`/`height`, wie der Composer immer sendet – auch Name und Größe dieses Uploads; CR2-07, `store/blobs.ts`).

**Upload Phase 3 (ADR-146, WP-53):** Header-`Content-Type` ∈ `UPLOAD_MEDIA_TYPES` (Bilder,
`application/pdf`, `application/octet-stream`), `bodyLimit = UPLOAD_BODY_LIMIT_BYTES` (größtes
Typ-Limit). Deklarierter Typ und Magic-Bytes entscheiden: Bild nur, wenn als Bild deklariert, ≤
`imageBytes` (nur solche Uploads hat der Composer skaliert); `%PDF-` (deklariert als PDF oder
octet-stream) → `application/pdf` ≤ `pdfBytes`, ohne Pixelgröße; jeder andere octet-stream-Upload –
**auch mit Bild-Bytes** (CR3-03, ADR-157) – ist eine Datei `application/octet-stream` ≤
`fileAttachmentBytes`, `name` Pflicht (400 `VALIDATION_FAILED {reason: 'name'}`), ohne Pixelgröße.
Ein deklariertes Bild/PDF, das keines ist, und ein leerer Körper → 415; über dem Typ-Limit → 413.
Antwort unverändert.

**Dateiinhalt (Phase 3, ADR-142, WP-53):** `GET`/`HEAD /api/file?entryId=…&path=…`
(`fileQuerySchema`, sonst 400 `VALIDATION_FAILED {reason: 'query'}`), Guard-Klasse `file`.
`options.files` (`FileContentProvider`, `files/service.ts`) prüft wie `file.stat`; ohne Dienst 501
`NOT_IMPLEMENTED`. Header: `Content-Type` des Dienstes, `Content-Length`, `Content-Disposition:
inline; filename*=UTF-8''…` (alles außerhalb der attr-chars kodiert), `Cache-Control: no-store`,
CORP `same-origin`, `BLOB_CSP` + `X-Frame-Options: DENY` bzw. für PDFs `FILE_PDF_CSP` +
`SAMEORIGIN`. Fehler `ErrorPayload` mit Katalog-Status. `HEAD` liefert dieselben Header ohne Körper.
Blobs mit Meta `application/pdf` und `%PDF-`-Körper bekommen ebenfalls den PDF-Header-Satz.

Verdrahtung (WP-20, `main.ts`):

```ts
const config = loadConfig();
const logging = await initLogging({ home: config.home, dev: config.dev, level: config.logLevel });
const instance = createServerInstance();
const warnings = createStoreWarnings();
// Stores zuerst laden: StoreVersionTooNewError → Start abbrechen (R1-06, ADR-020)
const auth = await createAuthService({ home: config.home, serverInstanceId: instance.serverInstanceId, warnings });
const blobs = createBlobStore({ home: config.home });
const manager = createSessionManager({ /* WP-13 */ });
const hub = createSyncHub({ source: manager, instance, validation: config.validation }); // R3-05: Default log
manager.attachPublisher(hub); // vor manager.start() (WP-13 §3.5, R1-18)
const app = await createApp({ config, instance, auth, blobs, hub, webRoot });
await app.listen({ host: config.host, port: config.port }); // host ist immer 127.0.0.1 (R1-05)
// WP-21: server.lock.json mit auth.launcherToken; erster Start: auth.issueAuthCode()
```

Start-Abbruch bei einer Store-Datei mit neuerer `schemaVersion` (R1-06): `StoreVersionTooNewError`
aus `store/jsonStore.ts` fangen, `error.message` (Englisch, „update Parallax“) auf stderr und ins
Log schreiben und mit `STORE_VERSION_TOO_NEW_EXIT_CODE` (3) beenden – die Datei bleibt unverändert.
