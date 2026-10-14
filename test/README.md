# test – Test-Infrastruktur

- `setup/` – Vitest-Setup: `PARALLAX_HOME` = Temp-Verzeichnis und `PARALLAX_PORT=0`, falls nicht
  gesetzt; Schutz gegen das echte `%LOCALAPPDATA%\Parallax`; RTL-Cleanup für Web-Tests.
- `fixtures/sdk/` – bereinigte SDK-Message-Streams (`*.jsonl`) aus `pnpm record` (WP-01).

Unit- und Integrationstests liegen als `*.test.ts(x)` **neben dem Code** in `src/**`.
