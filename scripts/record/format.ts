/**
 * Fixture format of test/fixtures/sdk/<scenario>.jsonl (documented in docs/sdk-findings.md).
 *
 * The format lives in src/server/backend/fixture.ts (single source, WP-02); this module
 * re-exports it for the recorder (scripts may import server modules, ADR-003).
 */
export {
  EVENT_KINDS,
  FIXTURE_VERSION,
  fixtureEventSchema,
  fixtureHeaderSchema,
  parseFixture,
  type EventKind,
  type FixtureEvent,
  type FixtureHeader,
  type ParsedFixture,
} from '../../src/server/backend/fixture';
