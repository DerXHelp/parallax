import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { fastify, type FastifyInstance } from 'fastify';
import { PRODUCT_ID } from '@shared/product';

export interface BootstrapAppOptions {
  /** Directory with the built web UI (dist/web). Not served when missing (dev mode uses Vite). */
  webRoot?: string;
}

/**
 * Temporary bootstrap app from WP-00 so that `pnpm dev`, `pnpm build` and `pnpm start` work.
 * WP-10 builds the real app (config, auth, HTTP/WS, sync); WP-20 wires it into main.ts
 * and deletes this file. No security features here on purpose.
 */
export async function createBootstrapApp(options: BootstrapAppOptions = {}): Promise<FastifyInstance> {
  const app = fastify({ logger: false });

  app.get('/api/health', () => ({ ok: true, product: PRODUCT_ID }));

  if (options.webRoot !== undefined && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, { root: options.webRoot });
  }

  return app;
}
