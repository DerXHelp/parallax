import { pino, type Logger } from 'pino';
import { PRODUCT_ID } from '@shared/product';

/**
 * The one logger of the server. Never use console.* in src/server.
 *
 * Placeholder from WP-00. WP-10 extends it: redaction of env values and tokens,
 * file rotation (pino-roll) under PARALLAX_HOME/logs, pretty output in dev mode.
 */
export const logger: Logger = pino({ name: PRODUCT_ID, level: 'info' });
