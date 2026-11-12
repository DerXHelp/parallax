# scripts – Werkzeuge (laufen mit tsx, tsconfig `tsconfig.tools.json`)

| Skript            | Befehl              | Owner-WP | Stand                 |
| ----------------- | ------------------- | -------- | --------------------- |
| `build.ts`        | `pnpm build`        | CR-08    | fertig (beide Schritte unter dem Build-Lock, ADR-094) |
| `build-server.ts` | `pnpm build:server` | 00       | fertig                |
| `preflight.ts`    | `pnpm preflight`    | 11       | fertig (WP-11)        |
| `record.ts`       | `pnpm record <sz>`  | 01       | fertig (WP-01, Env/Auth seit WP-11 über `src/server/claude`) |
| `cli-check.ts`    | `pnpm cli-check [--accept] [--last] [--profile=<f>]` | 62 | fertig (WP-62, Kurz-Check nach `claude`-Updates; Module in `cli-check/`) |
| `bundle-budget.ts` | `pnpm exec tsx --tsconfig tsconfig.tools.json scripts/bundle-budget.ts [--lazy]` | FIX-R5-F6 | fertig (Start-Chunks gegen `109c073`, nach `pnpm build`; liest nur `dist/web`) |

## `pnpm preflight` (WP-11)

Umgebungscheck mit englischer Ausgabe; ruft nur `claude --version` und `claude auth status --json`
auf (kein Modell-Aufruf, keine Tokens). Geprüft werden: Node (Fehler unter 22, Warnung ≠ 26), pnpm
(≥ 12.8), Registry (`pnpm config get registry`, ohne Zugangsdaten angezeigt), Agent SDK, für jedes
Profil (Phase 1: „Standard“) der aufgelöste `claude`-Pfad mit Version (rot, wenn älter als
`claudeCodeVersion` des SDK) und der Login (Methode, Provider, Abo – nie E-Mail/Organisation),
Google Chrome (App Paths bzw. Program Files/%LOCALAPPDATA%, mit Version aus der Versionsressource
von `chrome.exe` – Chrome wird dafür nicht gestartet; ADR-136) und – seit den R1-Fixes – registrierte Virenscanner
(Windows-Sicherheitscenter per CIM, ohne Admin-Rechte): Warnung bei Produkten mit Web-Traffic-Scan
(Kaspersky, ESET, Bitdefender, Avast, AVG; README „Virenscanner mit Web-Traffic-Scan“), sonst Info;
ist das Sicherheitscenter nicht lesbar (z. B. Windows Server), entfällt die Zeile.

Der Recorder (`scripts/record/processes.ts`) startet PowerShell und `taskkill` nur noch über
`runFile` mit absolutem System32-Pfad (R1-04/R1-16).

Exit-Code: `0` = ok (Warnungen erlaubt), `1` = mindestens ein Fehler, `2` = der Check selbst ist
abgestürzt. Logik: `src/server/claude/preflight.ts`.

## `pnpm cli-check` (WP-62)

Kurz-Check nach einem `claude`-Update (Stufe 1, `docs/sdk-upgrade.md`; Ablauf für den Koordinator:
Skill `/claude-update`). **Live**, aber billig: Haiku, Abo-Login, höchstens 0,05 USD je Check
(Dauerfreigabe des Nutzers 12.11.2026). Schwerer Lauf (Playwright): niedrige Priorität, nie parallel
zu `pnpm check`/`build`/`e2e` (ADR-154). Dauer ≈ 1,5–3 min, Kosten ≈ 0,01 USD.

1. Vorprüfung ohne Kosten (`cli-check/precheck.ts`): echte Profilprüfung „Standard“ (`claude --version`,
   `auth status` über `buildEnv`), Login `claude.ai`/`firstParty`, keine `ANTHROPIC_API_KEY`/
   `_AUTH_TOKEN`/`_BASE_URL`, Versionsregel C.7. Fehlschlag → Exit 2 ohne Live-Aufruf.
2. Probe (`cli-check/probe.ts`): eine SDK-Session wie ein Parallax-Start (`launchSpecFor`,
   `buildQueryOptions`, `createSpawner`), aber isoliert (`settingSources: []`, keine MCP-Server, alle
   Werkzeuge verweigert), Temp-Scratch `%TEMP%\parallax-cli-check-<zeit>-*` mit Temp-Home, eine
   Haiku-Runde („Reply with exactly: OK“). Sammelt `system/init`, `initializationResult()` (nur
   Schlüssel), `supportedModels()`, `getContextUsage()` (Kategorie-`id`s). Guards wie der Recorder
   (ADR-011). WP-64 (`cli-check/remoteControl.ts`): danach `enableRemoteControl(true, 'Parallax cli-check')`,
   Antwort gegen `remoteControlAnswerSchema` (claude.ai-`session_url`), `bridge_state connected` in
   15 s, dann immer `enableRemoteControl(false)` – Ergebnis `remoteControl: true/false` im Profil, ein
   Fehlschlag bricht nie ab (er ist der Befund); kein Modell-Turn, keine Kosten.
3. Live-Smoke `e2e/live` mit dem Restbudget (`cli-check/smoke.ts`; JSON-Reporter, eigener
   Playwright-Ausgabeordner `test-results/cli-check/<zeit>-smoke/` – Playwright leert ihn beim Start,
   frühere Berichte bleiben –, `live-run.json` mit Kosten und Temp-Wurzel).
4. Vergleich mit `src/server/claude/cli-profile.json` (`cli-check/compare.ts`): Werkzeuge
   (Kern-Werkzeuge, `TodoWrite`/`TaskCreate` → ADR-156), Init-Schlüssel, `initializationResult`-Schlüssel,
   Capabilities, Modelle, Kontext-Kategorien, `permissionMode`-Default, deferred Werkzeuge (falls die CLI
   sie meldet), Remote Control (`true` ↔ `false`, WP-64); Smoke-Fehler, `unknownCounts`, Validierungs-Drops. Nur Notizen: Slash-Commands, Agents,
   Skills, Modell-ID, Versionen.
5. Bericht `test-results/cli-check/<zeit>.md` (Englisch, je Abweichung die betroffene Stelle) plus
   `last-run.json`; Konsolen-Zusammenfassung. Exit 0 = grün, 1 = Abweichungen, 2 = Abbruch/Fehler.
   Achtung: `pnpm e2e` leert `test-results/` – auch diese Dateien (vorher lesen bzw. übernehmen).
6. Budget: Probe + Smoke ≤ 0,05 USD (der Smoke prüft `PARALLAX_LIVE_BUDGET_USD` vor jedem Prompt).
7. Rückbau (`cli-check/cleanup.ts`): Scratch-Ordner, CLI-Transkriptordner unter `~/.claude/projects` der
   eigenen Temp-Wurzeln (nur wenn jede `cwd`-Zeile darin liegt), CLI-Task-Ordner
   `%TEMP%\claude\<hash>\<session-id>` der eigenen Sessions; Plan-Dateien und `~/.claude.json` nur
   gemeldet.

`--accept` schreibt danach das Profil (und eine Zeile in `docs/cli-updates.md`) und endet mit 0;
`--last` vergleicht den letzten Lauf erneut ohne Live-Aufruf (`--last --accept` übernimmt ihn);
`--profile=<datei>` vergleicht mit einer anderen Profildatei (und schreibt beim Übernehmen keine
Protokollzeile). Testdaten der Module: `cli-check/samples.ts`; Tests ohne Live-Aufruf.

## `pnpm record` (WP-01)

Fixture-Recorder gegen das echte `claude` (nur mit `PARALLAX_LIVE=1` und WP-Freigabe):
`pnpm record --list | --stats | --resanitize [szenario…]`, `PARALLAX_LIVE=1 pnpm record <szenario…|all>`.
Guards und Fixture-Format: `docs/sdk-findings.md` („Recorder“, „Fixture-Format“), ADR-010/011.
Seit WP-11 nutzt der Recorder `buildEnvReport()` und `parseAuthStatus()` aus `src/server/claude`;
spike-eigen bleiben nur das Entfernen von `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/
`ANTHROPIC_BASE_URL`, der `PARALLAX_LIVE`-Guard und `PARALLAX_ENTRY_ID=spike`.

Der Launcher für `pnpm start` (unsichtbarer Server, Chrome-App-Fenster) liegt in
`src/server/launcher/` (WP-21, README dort).

## `pnpm build:server` und die Build-ID

`build-server.ts` bündelt `src/server/main.ts` nach `dist/server.js` (esbuild, ADR-004) und trägt die
Build-ID (`resolveBuildId()` aus `repo.config.ts`) per `define` und in der ersten Zeile ein; Vite
schreibt dieselbe ID nach `dist/web/build.json`. Die ID ist `<version>+<letzter Commit, der eine
Build-Eingabe geändert hat>[.dirty-<Digest>]` (ADR-065): ein reiner Doku- oder Test-Commit ändert sie
nicht und erzwingt keinen Neubau. Ein laufender Server liefert seine beim Start fixierte UI-Kopie
aus (`PARALLAX_HOME/ui/<buildId>`, ADR-066) – ein späteres `pnpm build`/`pnpm e2e` stört ihn nicht.
Das Bündeln läuft unter dem Build-Lock des Checkouts (ADR-092; wartet auf einen Build des
Launchers oder der E2E); hält der Aufrufer ihn schon (`runBuild`, `PARALLAX_BUILD_LOCK_HELD=1`),
wird er nicht erneut genommen. `pnpm build` (`build.ts` → `buildUnderLock`) nimmt den Lock einmal
für beide Schritte (`build:web` + `build:server`); ein zweiter Build desselben Checkouts wartet
(ADR-094). Die Ausgabe der Schritte zeigt es nur bei einem Fehler.

`pnpm preflight` meldet seit ADR-136 Chrome-Richtlinien (HKLM/HKCU
`SOFTWARE\Policies\Google\Chrome`, dazu die Listen `URLBlocklist` und `NotificationsBlockedForUrls`),
die das App-Fenster übersteuern (`warn`: Anmeldung erzwungen, `UserDataDir`, Gast-/Inkognito-Zwang,
erzwungene Profilauswahl, blockierte Benachrichtigungen, `AutoplayAllowed=0`, gesperrte
`127.0.0.1`), bzw. übrige Sign-in/Sync-Richtlinien (`info`); ohne relevante Richtlinie
`OK chrome policies none`.
