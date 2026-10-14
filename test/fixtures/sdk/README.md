# test/fixtures/sdk – SDK-Fixtures (WP-01)

Bereinigte Aufzeichnungen echter SDK-Message-Streams (CLI 2.1.300, SDK 0.3.296, Haiku), eine Datei
pro Szenario (`<szenario>.jsonl`), erzeugt mit `PARALLAX_LIVE=1 pnpm record <szenario>`. Grundlage
für Normalizer-Snapshots (WP-12) und das FakeBackend (WP-13).

- **Format v1** (ADR-010): Zeile 1 Header `{fixtureVersion, scenario, description, sdkVersion,
  cliVersion, recordedAt, options}`, danach Events `{seq, tMs, kind, payload}`. Kinds und Bedeutung:
  `docs/sdk-findings.md`, Abschnitt „Fixture-Format“. Parser/Validierung: `scripts/record/format.ts`.
- `fixtures.test.ts` prüft jede Datei (gültiges JSONL, Header passt zum Dateinamen, lückenlose `seq`,
  keine Benutzerpfade/E-Mails/Tokens).
- Szenarien: `pnpm record --list`; Übersicht der Message-Typen: `pnpm record --stats`.
- Nur diese Dateien werden committet (`.gitignore` ignoriert `*.jsonl` überall sonst).
- Rohaufzeichnungen liegen in `.recordings/` (ignoriert, unbereinigt); `pnpm record --resanitize`
  erzeugt die Fixtures daraus neu.
- **Aufzeichnungen vom Arbeitsrechner kommen nie ins Repo.**
