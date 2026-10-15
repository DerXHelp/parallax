# synthetic – synthetische SDK-Streams (WP-12, R0-06)

SDK-Typen ohne aufgezeichnetes Fixture als `.ts`-Module im Fixture-Format v1
(`export const events: FixtureEvent[]`, nie `.jsonl` – die wären git-ignoriert). `build.ts` enthält
die Factories (Formen wie SDK 0.3.296 bzw. die Aufzeichnungen), `index.ts` die Liste
`SYNTHETIC_STREAMS`. `synthetic.test.ts` prüft jedes Event mit `fixtureEventSchema`/`parseFixture`,
spielt jeden Stream durch den Live-Adapter (Datei-Snapshots `../__snapshots__/synthetic/`) und
prüft das Verhalten gezielt. Abgedeckte Typen: `docs/wp/WP-12.md`.
