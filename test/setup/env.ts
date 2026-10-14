import { ensureTestEnv } from './home';

// Per-worker safety net in case a worker did not inherit the env from globalSetup.
ensureTestEnv();
