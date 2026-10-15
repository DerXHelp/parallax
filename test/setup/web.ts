import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy*/waitFor wait for an element or a condition, never for a fixed time. Their default limit
// of 1 s is a wall-clock assumption that failed under parallel test load (lazy chunks, menus that
// open asynchronously; docs/wp/FLAKES.md). A missing element still fails, only later.
configure({ asyncUtilTimeout: 5_000 });

// Vitest runs without globals, so React Testing Library cannot register its auto-cleanup.
afterEach(() => {
  cleanup();
});
