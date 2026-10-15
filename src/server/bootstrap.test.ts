import { describe, expect, it } from 'vitest';
import { createBootstrapApp } from './bootstrap';

describe('bootstrap app', () => {
  // V1-07: the cold import of fastify + @fastify/static can exceed the 5 s default under parallel load.
  it('answers the health check', { timeout: 30_000 }, async () => {
    const app = await createBootstrapApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, product: 'parallax' });
    } finally {
      await app.close();
    }
  });
});
