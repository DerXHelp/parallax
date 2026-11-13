import { z } from 'zod';

/**
 * zod 4 probes `new Function('')` when an object schema is CREATED (JIT parser). The page CSP
 * (`script-src 'self'`) forbids eval, so the probe shows up as a CSP violation in every window
 * (V1-09). Imported first in main.tsx – before any module defines a schema – to switch the JIT
 * off; parsing stays the same, only slightly slower for large objects. In the build the module
 * sits in the `vendor` chunk next to zod (vite.config.ts, WP-66): chunks with schemas of their own
 * (e.g. the shared contracts) run before the body of `index`, but never before `vendor`.
 */
z.config({ jitless: true });
