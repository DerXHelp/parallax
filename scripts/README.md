# scripts – Werkzeuge (laufen mit tsx, tsconfig `tsconfig.tools.json`)

| Skript            | Befehl              | Owner-WP | Stand                 |
| ----------------- | ------------------- | -------- | --------------------- |
| `build-server.ts` | `pnpm build:server` | 00       | fertig                |
| `preflight.ts`    | `pnpm preflight`    | 11       | fertig (WP-11)        |
| `record.ts`       | `pnpm record <sz>`  | 01       | fertig (WP-01, Env/Auth seit WP-11 über `src/server/claude`) |

## `pnpm preflight` (WP-11)

Umgebungscheck mit englischer Ausgabe; ruft nur `claude --version` und `claude auth status --json`
auf (kein Modell-Aufruf, keine Tokens). Geprüft werden: Node (Fehler unter 22, Warnung ≠ 26), pnpm
(≥ 12.8), Registry (`pnpm config get registry`, ohne Zugangsdaten angezeigt), Agent SDK, für jedes
Profil (Phase 1: „Standard“) der aufgelöste `claude`-Pfad mit Version (rot, wenn älter als
`claudeCodeVersion` des SDK) und der Login (Methode, Provider, Abo – nie E-Mail/Organisation),
Microsoft Edge (App Paths bzw. Program Files).

Exit-Code: `0` = ok (Warnungen erlaubt), `1` = mindestens ein Fehler, `2` = der Check selbst ist
abgestürzt. Logik: `src/server/claude/preflight.ts`.

## `pnpm record` (WP-01)

Fixture-Recorder gegen das echte `claude` (nur mit `PARALLAX_LIVE=1` und WP-Freigabe):
`pnpm record --list | --stats | --resanitize [szenario…]`, `PARALLAX_LIVE=1 pnpm record <szenario…|all>`.
Guards und Fixture-Format: `docs/sdk-findings.md` („Recorder“, „Fixture-Format“), ADR-010/011.
Seit WP-11 nutzt der Recorder `buildEnvReport()` und `parseAuthStatus()` aus `src/server/claude`;
spike-eigen bleiben nur das Entfernen von `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/
`ANTHROPIC_BASE_URL`, der `PARALLAX_LIVE`-Guard und `PARALLAX_ENTRY_ID=spike`.

Der Launcher für `pnpm start` (unsichtbarer Server, Edge-App-Fenster) folgt in WP-21.
