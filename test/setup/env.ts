import { ensureTestEnv } from './home';

// Per-worker safety net: keeps the temp home of the globalSetup (a `parallax-test-*` folder in
// the OS temp directory), replaces anything else (WP22-07).
ensureTestEnv();
