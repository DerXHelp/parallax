# src/server/sessions – Normalizer, Status, SessionManager

- WP-12: Normalizer mit zwei Eingangsadaptern (live und Verlauf) → identische UI-Items,
  Statusmaschine; Snapshot-Tests gegen `test/fixtures/sdk/*.jsonl`.
- WP-13: SessionManager (Queue, Interrupt, Modell/Mode, Crash/interrupted) und
  PermissionBroker (mehrere offene Entscheidungen pro Session).

Details: `docs/plan.md`, „Server-Bausteine“ und Review A.3–A.6.
