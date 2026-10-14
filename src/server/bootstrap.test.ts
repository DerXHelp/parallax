import { describe, expect, it } from 'vitest';
import { createBootstrapApp } from './bootstrap';

describe('bootstrap app', () => {
  it('answers the health check', async () => {
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
