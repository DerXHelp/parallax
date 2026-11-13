# `claude`-Updates – Protokoll

Eine Zeile je `pnpm cli-check --accept` (WP-62; Ablauf: Skill `/claude-update`, `docs/sdk-upgrade.md`
„Stufe 1: Kurz-Check“). Die Zeilen schreibt das Skript, das Profil steht in
`src/server/claude/cli-profile.json`.

| Datum | `claude` alt → neu | SDK | Ergebnis | Kosten (USD) |
|---|---|---|---|---|
| 2026-11-12 | – → 2.1.322 | 0.3.322 | erstes Profil (WP-62) | 0,0107 |
| 2026-11-13 | 2.1.322 → 2.1.323 | 0.3.322 | 1 Abweichung, akzeptiert | 0,0107 |
| 2026-11-13 | 2.1.323 → 2.1.323 | 0.3.322 | grün, 15 neue Proben aus WP-64…67 erstmals live (`feature/ux-feedback`) | 0,0075 |
| 2026-11-13 | 2.1.323 → 2.1.323 | 0.3.322 | grün, Proben aus WP-70 (Anmelde-Methoden nur Existenz, Ausgabestil-Rundlauf) erstmals live (`feature/ux-feedback`) | 0,0106 |
