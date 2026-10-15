/**
 * All synthetic streams (R0-06) by name – SDK types without a recorded fixture. Each module
 * exports `events: FixtureEvent[]` (fixture format v1, validated in synthetic.test.ts).
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { events as abortedStream } from './aborted-stream';
import { events as autoModeDenied } from './auto-mode-denied';
import { events as compactRetry } from './compact-retry';
import { events as errors } from './errors';
import { events as hooksNotices } from './hooks-notices';
import { events as largeOutput } from './large-output';
import { events as legacyCli } from './legacy-cli';
import { events as rateLimits } from './rate-limits';
import { events as refusalFallback } from './refusal-fallback';
import { events as staleConversation } from './stale-conversation';
import { events as tasksProgress } from './tasks-progress';
import { events as unknownTypes } from './unknown-types';

export const SYNTHETIC_STREAMS: Readonly<Record<string, FixtureEvent[]>> = {
  'aborted-stream': abortedStream,
  'auto-mode-denied': autoModeDenied,
  'compact-retry': compactRetry,
  errors,
  'hooks-notices': hooksNotices,
  'large-output': largeOutput,
  'legacy-cli': legacyCli,
  'rate-limits': rateLimits,
  'refusal-fallback': refusalFallback,
  'stale-conversation': staleConversation,
  'tasks-progress': tasksProgress,
  'unknown-types': unknownTypes,
};
