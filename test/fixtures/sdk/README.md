# test/fixtures/sdk – SDK-Fixtures (WP-01)

Bereinigte Aufzeichnungen echter SDK-Message-Streams, eine Datei pro Szenario
(`<szenario>.jsonl`), erzeugt mit `pnpm record <szenario>`. Grundlage für Normalizer-Snapshots
und das FakeBackend.

- Nur diese Dateien werden committet (`.gitignore` ignoriert `*.jsonl` überall sonst).
- Rohaufzeichnungen liegen in `.recordings/` (ignoriert).
- **Aufzeichnungen vom Arbeitsrechner kommen nie ins Repo.**
