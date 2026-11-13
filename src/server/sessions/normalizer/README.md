# src/server/sessions/normalizer – Normalizer (WP-12)

Rohe SDK-Messages → `TranscriptItem`s, `SessionOp`s und `StatusSignal`s. Port:
`../ports.ts` (eingefroren), Regeln: `docs/architecture.md` §6, Details/Entscheidungen/Lücken:
`docs/wp/WP-12.md`. Reine Funktionen bis auf `ctx.storeBlob`; keine I/O.

| Datei | Inhalt |
|---|---|
| `index.ts` | öffentliche Exporte: `createLiveNormalizer`, `normalizeHistory`, `normalizeContextUsage` (Port-Typen) + `estimateContextGauge`, `modelContextWindow`, `capText`, `capInput` (für die Engine, WP-13 §6 Nr. 6). Seit R1-07 trägt `context_estimate` `contextWindow` (aus `modelUsage` des letzten `result`); der Verlauf übernimmt `HistoryMessage.origin` für `user_message.origin` |
| `live.ts` | Live-Adapter (Stream-Events, finale Messages per Message-ID, Tool-Paarung, Tasks – `task_progress.description` ist die Tätigkeit, nie der Name (WP61-07, ADR-156) –, Reset, Zähler; `rate_limit_event`: Signal immer, Transkript-Item nur bei `rejected` – WP-63) |
| `bridge.ts` | WP-65: `task_summary` → Signal `task_summary` (CLI-Satz, `detail: null` beendet ihn), `post_turn_summary` → Signal `turn_summary` nur, wenn `summarizes_uuid` eine Hauptthread-Antwort des laufenden bzw. zuletzt beendeten Turns ist (sonst gezählt als `system/post_turn_summary:stale`). WP-64: System-Messages der Remote-Control-Bridge (untypisiert) als Tabelle Subtyp → Handler: `bridge_state` → Signal `bridge_state` (unbekannter Zustand → `unknown`, gezählt); `task_summary`/`post_turn_summary` vorerst gezählt-ignoriert (WP-65 ersetzt die Einträge) – nie ein `unknown`-Item. Replays (`--replay-user-messages`, immer an): eigene uuids verworfen, fremde mit `origin human` → `user_message` `source: 'remote'` (`live.ts`) |
| `history.ts` | Verlaufs-Adapter (`getSessionMessages` + Subagent-Messages, nach Zeit gemischt) |
| `context.ts` | Context-Gauge (C.1): `getContextUsage` → `ContextBreakdown` (WP-63: mit `autoCompactThreshold` – ganzzahlig, negativ/ungültig → `null` – und `isAutoCompactEnabled`), Schätzung während des Turns (übernimmt die Autocompact-Felder des letzten Werts, `AutoCompactInfo`) |
| `builders.ts` | gemeinsame Item-Bausteine beider Adapter (IDs, Tool-Status, Tasks, User-Text-Klassifikation; `<task-notification>`-Text nur mit `origin.kind === 'task-notification'` beim Hauptagenten, ohne `origin` angezeigt ohne `outputFile` – ADR-152) |
| `limits.ts` | Kappung, Blobs, Dedupe von `structured`, Item-Budget (`LIMITS`, R0-11) |
| `sdk-schemas.ts` | tolerante zod-Sichten der SDK-Messages (`looseObject`, `opt()`) |
| `synthetic/*.ts` | synthetische Streams (Fixture-Format v1, R0-06) für nicht aufgezeichnete SDK-Typen |
| `testing/harness.ts` | Test-Harness: spielt Fixtures wie die Engine ab (`replayLive`, `replayStatus`, Verlauf-Mapping) |
| `*.test.ts`, `__snapshots__/` | Fixture-Contract-Tests mit Datei-Snapshots (`live/`, `history/`, `context/`, `synthetic/`) |

Snapshots aktualisieren (nur nach Prüfung des Diffs, z. B. nach einem SDK-Upgrade):
`pnpm exec vitest run src/server/sessions -u`.
