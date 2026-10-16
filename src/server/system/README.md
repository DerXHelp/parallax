# src/server/system – Windows-Integration (Phase 2)

Owner: **WP-33** (außer `ports.ts`: Koordinator, eingefroren). Auftrag: `docs/wp/WP-33.md`.

Sichtbare Konsole für `claude --resume <id>` (ADR-104), Autostart-Verknüpfung (ADR-110) und der
optionale Protokoll-Handler `parallax:` (ADR-109). Nur der produktive Server (Standard-Datenordner,
SDK-Backend, kein `--dev`; `--system-integration=on` erzwingt es) ändert HKCU oder den
Autostart-Ordner – Tests, Dev- und Fake-Server nie.

| Datei | Inhalt |
| --- | --- |
| `ports.ts` | Port `ConsoleLauncher`, `ConsoleProcess`, `ConsoleOpenResult`, `SystemIntegration` (nur Typen) |

Weitere Module legt WP-33 an (`console.ts`, `fakeConsole.ts`, `autostart.ts`, `protocol.ts`,
`index.ts`) und trägt sie hier ein.
