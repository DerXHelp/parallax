# src/server/sessions/status – Statusmaschine (WP-12)

`machine.ts` exportiert `reduceStatus: ReduceStatus` (Port `../ports.ts`): reiner Reducer der
`StatusFacts` aus Normalizer-Signalen und Engine-Ereignissen. Regeln: `docs/architecture.md` §7,
WP-02 §9.4, R0-05; Entscheidungen und Ergänzungen: `docs/wp/WP-12.md`. Die Anzeige leitet
ausschließlich `deriveDisplayStatus` (`@shared/status`) ab – hier wird nichts dupliziert.

- `machine.test.ts` – Tabellentests aller Pflichtregeln.
- `fixtures.test.ts` – Statusverlauf je Fixture und je synthetischem Stream (Datei-Snapshots in
  `__snapshots__/`), erwartete Sequenzen für die Kern-Szenarien.
