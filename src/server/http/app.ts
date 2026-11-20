import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  fastify,
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import type { Logger } from 'pino';
import { LIMITS } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  API_PATHS,
  BLOB_CSP,
  DEV_AUTH_CODE_TTL_MS,
  DEV_WEB_PORT,
  HOST_API_PATHS,
  appUrlWithCode,
  pageCsp,
  serverOrigin,
  type BackendKind,
  type HealthResponse,
} from '@shared/http';
import { PRODUCT_ID } from '@shared/product';
import { WS_CLOSE } from '@shared/protocol';
import type { ServerConfig, ServerInstance } from '../config';
import type { FileContentProvider } from '../files/ports';
import type { HostsService } from '../hosts/ports';
import { logger as rootLogger } from '../lib/logger';
import type { BlobStore } from '../sync/ports';
import type { TerminalService } from '../terminal/ports';
import { registerTerminalRoute } from '../terminal/socket';
import type { UpdateService } from '../update/ports';
import { registerUpdateRoutes } from '../update/routes';
import { registerAuthRoutes, type AuthService } from './auth';
import { contentErrorHandler, registerContentRoutes } from './content';
import { registerHostRoutes } from './hostRoutes';
import { STATIC_ROUTE, checkRequest, requestPath } from './origin';
import { replyError, sendError } from './reply';

// The header policy of content answers moved to content.ts (WP-78b); re-exported for existing users.
export {
  UPLOAD_BODY_LIMIT_BYTES,
  contentPolicyHeaders,
  inlineDisposition,
  isPdfBlob,
  mediaTypeEssence,
  safeMediaType,
} from './content';

/**
 * The Fastify app (docs/architecture.md §5.1): request guard (Host/Origin/Sec-Fetch-Site + device
 * cookie, also for the WS upgrade – @fastify/websocket dispatches upgrades through the normal
 * hook chain), security headers + CSP (C.10), `/api/health`, auth routes, blobs, the upload
 * `POST /api/attachments` (images ADR-103; PDFs and other files ADR-146), file content
 * `GET /api/file` (ADR-142), the WS route of the hub and the static web UI. Never CORS headers.
 * WP-20/WP-60 wire it: `createApp({ config, instance, auth, blobs, hub, files })` → `app.listen(…)`.
 *
 * The guard classifies by the matched route (`request.routeOptions.url`), not by the URL text
 * (R1-01, ADR-018); the WS route repeats the whole check itself (second line, `authorizeUpgrade`).
 */

/** Options of `AttachableHub.attach` (the app hands the hub its WS authorization). */
export interface HubAttachOptions {
  /**
   * Second line of the WS guard (R1-01): Host, request target, Origin, Sec-Fetch-Site and cookie
   * of the upgrade request, independent of the global hook. null = authorized; otherwise the hub
   * answers the error over HTTP (preValidation) and never upgrades.
   */
  authorizeUpgrade(request: FastifyRequest): ErrorPayload | null;
}

/** What createApp needs from the sync hub (sync/hub.ts). */
export interface AttachableHub {
  /** Registers the WS route (`GET /api/ws`) on the app. */
  attach(app: FastifyInstance, options: HubAttachOptions): void;
  closeAll(code: number): void;
}

export interface CreateAppOptions {
  /** `backend` (R3-02) is reported by `/api/health` when given. */
  config: Pick<ServerConfig, 'port' | 'dev'> & { backend?: BackendKind };
  instance: ServerInstance;
  auth: AuthService;
  blobs: BlobStore;
  hub?: AttachableHub;
  /** File service behind `GET /api/file` (Phase 3, ADR-142); missing → 501 NOT_IMPLEMENTED. */
  files?: FileContentProvider;
  /** WP-87: update upload, "What's new" and notices (src/server/update/routes.ts); missing → no routes. */
  update?: UpdateService;
  /**
   * WP-79: the controlling side – forwarder routes `HOST_API_PATHS` (http/hostRoutes.ts) to the
   * coupled computers; missing → no routes (404).
   */
  hosts?: Pick<HostsService, 'list' | 'forwarder'>;
  /**
   * WP-99 (ADR-239): the embedded terminal – WS route `API_PATHS.terminalWs` (terminal/socket.ts,
   * guard class `ws`, second check at the upgrade); missing → no route (404).
   */
  terminal?: TerminalService;
  /** WP-87: close code of the shutdown (4504 when it is a restart for an update); default 4503. */
  closeCode?: () => number;
  /** Built web UI (`dist/web`); not served when null or missing (dev mode uses Vite). */
  webRoot?: string | null;
  logger?: Logger;
}

/** Body limit of the JSON routes (the upload has its own: UPLOAD_BODY_LIMIT_BYTES, C.11). */
export const JSON_BODY_LIMIT_BYTES = 64 * 1024;
/** Sockets that ignore the shutdown close frame are terminated after this delay. */
export const WS_SHUTDOWN_GRACE_MS = 1000;

// The page CSP (C.10) and the blob CSP come from @shared/http (`pageCsp`, `BLOB_CSP`; R3-14).

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const log = (options.logger ?? rootLogger).child({ module: 'http' });
  const { auth, blobs, instance } = options;
  const dev = options.config.dev;

  // Typed as the base logger so the app is a plain FastifyInstance (plugins, hub.attach).
  const fastifyLogger: FastifyBaseLogger = log;
  const app = fastify({
    loggerInstance: fastifyLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: JSON_BODY_LIMIT_BYTES,
  });

  /**
   * Actual listening port (config port 0 → the OS-assigned one); null while it is not known yet:
   * port 0 before `listen` (CR-07 – only `inject` reaches the app then).
   */
  const knownPort = (): number | null => {
    const address = app.server.address();
    if (address !== null && typeof address === 'object') return address.port;
    return options.config.port === 0 ? null : options.config.port;
  };
  /** For the routes: they run only after the guard accepted the request, i.e. with a known port. */
  const port = (): number => knownPort() ?? options.config.port;

  // ---- WebSocket plugin (explicit maxPayload, C.11) ----
  // Registered before the guard: its onRequest hook marks upgrade requests, so a rejected
  // upgrade's socket is destroyed after the HTTP error answer (plugin onResponse hook).
  await app.register(fastifyWebsocket, {
    options: { maxPayload: LIMITS.wsMaxPayloadBytes },
    preClose(done) {
      const clients = [...this.websocketServer.clients];
      // WP-87: read only now – nothing closes earlier, so no window reconnects to a dying server.
      const code = options.closeCode?.() ?? WS_CLOSE.SERVER_SHUTDOWN;
      const reason = code === WS_CLOSE.SERVER_RESTARTING ? 'server restarting' : 'server shutdown';
      for (const client of clients) client.close(code, reason);
      setTimeout(() => {
        for (const client of clients) client.terminate();
      }, WS_SHUTDOWN_GRACE_MS).unref();
      done();
    },
  });

  /**
   * Guard (§5.1) + device cookie for `request`, classified by the route pattern `route` (null =
   * no route matched). Returns the error to answer, or null.
   */
  const authorize = (
    request: FastifyRequest,
    route: string | null,
    upgrade: boolean,
  ): ErrorPayload | null => {
    const currentPort = knownPort();
    // CR-07: no Host header can name a server whose port is not known yet (never a RangeError/500).
    if (currentPort === null) return makeError('HOST_HEADER_REJECTED');
    const result = checkRequest(
      { method: request.method, url: request.url, route, upgrade, headers: request.headers },
      { port: currentPort, dev },
    );
    if (!result.ok) {
      log.warn(
        {
          method: request.method,
          path: requestPath(request.url).slice(0, 200),
          route,
          class: result.route,
          upgrade,
          host: request.headers.host ?? null,
          origin: request.headers.origin ?? null,
          site: request.headers['sec-fetch-site'] ?? null,
          error: result.error,
        },
        'request rejected',
      );
      return result.error;
    }
    if (result.needsCookie && !auth.isAuthenticated(request.headers.cookie, currentPort)) {
      return makeError('AUTH_REQUIRED');
    }
    return null;
  };

  /** Upgrade request: @fastify/websocket marks it (`request.ws`); the header covers a reordered hook chain. */
  const isUpgrade = (request: FastifyRequest): boolean => request.ws || request.headers.upgrade !== undefined;

  // ---- guard: Host / request target / Origin / Sec-Fetch-Site / cookie (also for WS upgrades) ----
  app.addHook('onRequest', (request, reply, done) => {
    // Routing has already happened: classify by the matched route, never by the URL text (R1-01).
    const error = authorize(request, request.routeOptions.url ?? null, isUpgrade(request));
    if (error !== null) {
      replyError(reply, error);
      return;
    }
    done();
  });

  // ---- security headers (C.10); no CORS headers, ever ----
  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.headers({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
    });
    // DENY unless a route chose its header set itself (PDF answers: SAMEORIGIN, ADR-142).
    if (!reply.hasHeader('x-frame-options')) void reply.header('x-frame-options', 'DENY');
    if (!reply.hasHeader('cross-origin-resource-policy'))
      void reply.header('cross-origin-resource-policy', 'same-origin');
    if (!reply.hasHeader('content-security-policy')) {
      // CR-07: without a known port (only an error answer) the strictest policy, never a throw.
      const currentPort = knownPort();
      void reply.header('content-security-policy', currentPort === null ? BLOB_CSP : pageCsp(currentPort));
    }
    // Everything but the static UI (API answers, errors, 404) is never cached.
    if (request.routeOptions.url !== STATIC_ROUTE && !reply.hasHeader('cache-control')) {
      void reply.header('cache-control', 'no-store');
    }
    done(null, payload);
  });

  app.setErrorHandler(contentErrorHandler(log));

  // Unknown routes and missing static files (R1-12, V1-06).
  app.setNotFoundHandler((request, reply) =>
    sendError(reply, makeError('ROUTE_NOT_FOUND', { path: requestPath(request.url).slice(0, 200) })),
  );

  // ---- routes ----
  const backend = options.config.backend;
  app.get(API_PATHS.health, (): HealthResponse => ({
    ok: true,
    product: PRODUCT_ID,
    serverInstanceId: instance.serverInstanceId,
    serverVersion: instance.serverVersion,
    buildId: instance.buildId,
    startedAt: instance.startedAt,
    ...(backend === undefined ? {} : { backend }),
  }));

  registerAuthRoutes(app, auth, { port });

  // Blob, file content (ADR-142, guard class "file": Sec-Fetch-Site same-origin required, Origin
  // if present allowed, cookie) and the upload (ADR-103/146, guard class "mutation": Origin,
  // same-origin, cookie) – content.ts, shared with the remote-access listener (WP-78b).
  await registerContentRoutes(app, {
    paths: API_PATHS,
    blobs,
    ...(options.files === undefined ? {} : { files: options.files }),
    logger: log,
  });

  // WP-87: POST /api/update/package (own scope, stream parser, guard class "mutation"), GET
  // /api/changelog and /api/notices (guard class "file": same-origin only, cookie).
  if (options.update !== undefined) await registerUpdateRoutes(app, options.update);

  if (options.hub !== undefined) {
    const hub = options.hub;
    // Second line: the WS route checks the upgrade again, independent of the onRequest hook.
    hub.attach(app, { authorizeUpgrade: (request) => authorize(request, API_PATHS.ws, true) });
    const off = auth.onRevoked(() => {
      hub.closeAll(WS_CLOSE.AUTH_REVOKED);
    });
    app.addHook('onClose', (_instance, done) => {
      off();
      done();
    });
  }

  // WP-99: the terminal socket – this computer only (never forwarded); sockets close with 4401 when
  // the device loses its sign-in (the route unsubscribes when the app closes).
  if (options.terminal !== undefined) {
    registerTerminalRoute(app, {
      service: options.terminal,
      authorize: (request) => authorize(request, API_PATHS.terminalWs, true),
      onRevoked: (listener) => auth.onRevoked(listener),
      logger: log,
    });
  }

  // WP-79: forwarder of the controlling computer (blob/file/ws like the local routes, upload a
  // mutation); the WS route repeats the guard itself like the hub's.
  if (options.hosts !== undefined) {
    const hostRoutes = await registerHostRoutes(app, {
      hosts: options.hosts,
      authorizeUpgrade: (request) => authorize(request, HOST_API_PATHS.ws, true),
      logger: log,
    });
    const off = auth.onRevoked(() => {
      hostRoutes.closeAll(WS_CLOSE.AUTH_REVOKED);
    });
    app.addHook('onClose', (_instance, done) => {
      off();
      done();
    });
  }

  if (options.webRoot !== undefined && options.webRoot !== null && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, {
      root: options.webRoot,
      index: ['index.html'],
      setHeaders: (reply, filePath) => {
        // The HTML must always be revalidated (new build id → new asset names).
        if (filePath.endsWith('.html')) void reply.header('cache-control', 'no-cache');
      },
    });
  }

  // ---- dev mode: one login URL in the log (only in dev a code reaches the log, §5.1) ----
  if (dev) {
    app.addHook('onListen', (done) => {
      const issued = auth.issueAuthCode(DEV_AUTH_CODE_TTL_MS);
      log.info(
        { url: appUrlWithCode(serverOrigin(DEV_WEB_PORT), issued.code), expiresAt: issued.expiresAt },
        'dev login URL',
      );
      done();
    });
  }

  return app;
}
