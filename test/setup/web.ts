import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without globals, so React Testing Library cannot register its auto-cleanup.
afterEach(() => {
  cleanup();
});
