# src/server/sessions/normalizer – Normalizer (WP-12)

Rohe SDK-Messages → `TranscriptItem`s, `SessionOp`s und `StatusSignal`s. Port:
`../ports.ts` (eingefroren), Regeln: `docs/architecture.md` §6, Details/Entscheidungen/Lücken:
`docs/wp/WP-12.md`. Reine Funktionen bis auf `ctx.storeBlob`; keine I/O.

| Datei | Inhalt |
|---|---|
| `index.ts` | öffentliche Exporte: `createLiveNormalizer`, `normalizeHistory`, `normalizeContextUsage` (Port-Typen) + `estimateContextGauge`, `modelContextWindow` |
| `live.ts` | Live-Adapter (Stream-Events, finale Messages per Message-ID, Tool-Paarung, Tasks, Reset, Zähler) |
| `history.ts` | Verlaufs-Adapter (`getSessionMessages` + Subagent-Messages, nach Zeit gemischt) |
| `context.ts` | Context-Gauge (C.1): `getContextUsage` → `ContextBreakdown`, Schätzung während des Turns |
| `builders.ts` | gemeinsame Item-Bausteine beider Adapter (IDs, Tool-Status, Tasks, User-Text-Klassifikation) |
| `limits.ts` | Kappung, Blobs, Dedupe von `structured`, Item-Budget (`LIMITS`, R0-11) |
| `sdk-schemas.ts` | tolerante zod-Sichten der SDK-Messages (`looseObject`, `opt()`) |
| `synthetic/*.ts` | synthetische Streams (Fixture-Format v1, R0-06) für nicht aufgezeichnete SDK-Typen |
| `testing/harness.ts` | Test-Harness: spielt Fixtures wie die Engine ab (`replayLive`, `replayStatus`, Verlauf-Mapping) |
| `*.test.ts`, `__snapshots__/` | Fixture-Contract-Tests mit Datei-Snapshots (`live/`, `history/`, `context/`, `synthetic/`) |

Snapshots aktualisieren (nur nach Prüfung des Diffs, z. B. nach einem SDK-Upgrade):
`pnpm exec vitest run src/server/sessions -u`.
