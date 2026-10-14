import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createBootstrapApp } from './bootstrap';
import { logger } from './lib/logger';

/**
 * Server entry point (bundled to dist/server.js).
 *
 * WP-00 stub: parses the CLI flags used by the pnpm scripts and starts the bootstrap app.
 * WP-10 owns the real config (flags > env > settings > defaults); WP-20 wires everything here.
 *
 * Flags: --dev, --backend=fake|sdk, --port=<0..65535>, --home=<dir>, --host=<addr>
 */
const ArgsSchema = z.object({
  dev: z.boolean().default(false),
  backend: z.enum(['fake', 'sdk']).default('sdk'),
  port: z.coerce.number().int().min(0).max(65535).default(4711),
  host: z.string().min(1).default('127.0.0.1'),
  home: z.string().min(1).optional(),
});

const { values } = parseArgs({
  options: {
    dev: { type: 'boolean' },
    backend: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    home: { type: 'string' },
  },
  strict: true,
});

const args = ArgsSchema.parse(values);

// In the bundle this file lives in dist/, the built UI in dist/web.
const webRoot = args.dev ? undefined : path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

const app = await createBootstrapApp(webRoot === undefined ? {} : { webRoot });
const address = await app.listen({ host: args.host, port: args.port });

logger.info(
  { address, dev: args.dev, backend: args.backend, home: args.home ?? null },
  'bootstrap server listening',
);
