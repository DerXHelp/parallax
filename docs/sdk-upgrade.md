# SDK-Upgrade-Prozess (`@anthropic-ai/claude-agent-sdk` und `claude`-CLI)

Plan B „SDK-Upgrade-Prozess“ (`docs/plan.md`): *Version anheben → typecheck → Fixture-Tests → neu
aufzeichnen → Snapshot-Diff → Zähler für unbekannte Message-Typen prüfen → Live-Smoke.* Diese Datei
beschreibt die Schritte für dieses Repo. Stand: SDK-0.3.322 (11.11.2026, SDK 0.3.322, CLI 2.1.322;
zuvor WP-22, SDK 0.3.296). Letzter Durchlauf: `docs/wp/SDK-0.3.322.md` §5.

Grundregeln: Das SDK ist **exakt** gepinnt (`CLAUDE.md` „Stack“); ein Upgrade ist ein eigenes
Arbeitspaket mit Koordinator-Freigabe (`package.json`/Lockfile sind tabu). Live-Schritte (Schritt 4
und 7) brauchen eine **Nutzer-Freigabe** (Abo-Login, Haiku, Budget, ADR-011) – ohne Freigabe endet
der Prozess nach Schritt 3 mit „live offen“.

Zwei Stufen (WP-62): **Stufe 1** ist der Kurz-Check bei jedem neuen `claude` (eigener Abschnitt
direkt hier unten, Skill `/claude-update`). **Stufe 2** ist der Ablauf ab Schritt 1 – für echte
SDK-Upgrades oder wenn Stufe 1 echte Änderungen zeigt.

## Stufe 1: Kurz-Check (`pnpm cli-check`, Skill `/claude-update`)

`claude` erscheint oft mehrmals pro Woche und aktualisiert sich selbst. Parallax kennt die zuletzt
geprüfte Version aus dem CLI-Profil `src/server/claude/cli-profile.json` (`testedVersion` im
`ClaudeInstallStatus`). Ist die installierte Version neuer, zeigen die Kopfzeile (`HostFacts`) und der
Profil-/Neue-Session-Status einen dezenten Hinweis („neuer als die mit Parallax geprüfte Version“),
`pnpm preflight` eine Warnung `newer than tested`.

- **Ablauf für den Koordinator:** Skill `.claude/skills/claude-update/SKILL.md` (`/claude-update`):
  Version vergleichen → `pnpm cli-check` im Worktree `fix/cli-<version>` von `main` → grün:
  `pnpm cli-check --last --accept`, `pnpm check` + `pnpm build`, Merge nach `main`, Push → sonst
  Abweichungen einordnen (klein: Fix + wie grün; größer: Nutzer) → ggf. Stufe 2 vorschlagen → Kurzbericht.
- **Freigabe:** Dauerfreigabe des Nutzers (12.11.2026): live ohne Rückfrage, Haiku, Abo-Login, kein
  API-Key, höchstens 0,05 USD je Check; nach grünem Check Merge nach `main` und Push, wenn nur das Profil
  oder kleine Anpassungen betroffen sind.
- **Was der Check macht** (Details `scripts/README.md`): Vorprüfung ohne Kosten (Version, Abo-Login, keine
  API-Key-Variablen, C.7) → Probe (eine isolierte Haiku-Runde: `system/init`, `initializationResult()`,
  `supportedModels()`, `getContextUsage()`, danach Remote Control ein/aus ohne Modell-Turn, WP-64, und
  ein Sitzungstitel, die Nutzungsabfrage und `backgroundTasks` vorhanden, WP-65, eine Seitenfrage und
  `cancelAsyncMessage` vorhanden, WP-66, jede Lese-Methode der Session-Info einmal, Aktionen nur
  vorhanden, WP-67) → Live-Smoke `e2e/live` (Schritt 7 unten) → Vergleich mit dem
  Profil → Bericht `test-results/cli-check/<zeit>.md` → Rückbau eigener Daten (Scratch, CLI-Transkripte,
  CLI-Task-Ordner; Plan-Dateien und `~/.claude.json` nur gemeldet). Exit 0 = grün, 1 = Abweichungen,
  2 = Abbruch (Auth-/Billing-Stopp nie wiederholen).
- **Kosten/Dauer:** ≈ 0,01 USD (Probe ≈ 0,002–0,005, Smoke ≈ 0,005), ≈ 1,5–3 min.
- **Protokoll:** `docs/cli-updates.md` (eine Zeile je `--accept`).
- **Was Stufe 1 nicht abdeckt:** Snapshot-Diff der Fixtures, neue Szenarien, Verhalten im Detail (z. B.
  die Punkte unter „Nach WP-61 bei jedem CLI-Upgrade prüfen“ – `@`-Regel, frischer Kontext). Werkzeuge
  (auch `TodoWrite`/`TaskCreate`, ADR-156) vergleicht der Check automatisch.

## 1. Version anheben

- In einem Worktree (`.worktrees/sdk-<version>`, Branch `wp/sdk-<version>`):
  `pnpm add -E @anthropic-ai/claude-agent-sdk@<version>` (exakt, keine Range), danach
  `pnpm install --frozen-lockfile` gegenprüfen. `minimumReleaseAge` (1 Tag) gilt – eine frisch
  veröffentlichte Version lässt sich erst danach installieren.
- **Peer-Ranges prüfen** (ADR-008): `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod` aus
  `node_modules/@anthropic-ai/claude-agent-sdk/package.json` mit unseren Versionen vergleichen.
- **Plattform-Binaries bleiben ausgeschlossen** (`ignoredOptionalDependencies` in
  `pnpm-workspace.yaml`): `node_modules` darf keine `claude-agent-sdk-win32-*` enthalten.
- Neue Mindest-CLI ablesen: `claudeCodeVersion` im SDK-Manifest. Die Versionsregel C.7 (UI
  „zu alt“, `pnpm preflight`) liest sie automatisch – mit `pnpm preflight` prüfen, ob das
  installierte `claude` reicht (`agent sdk … (expects claude >= …)`). Im Worktree mit eigenem
  Datenordner aufrufen (`pnpm preflight --home=<Temp-Ordner>`), damit der Check nicht den echten
  `%LOCALAPPDATA%\Parallax` liest.
- Der Test `src/server/claude/resolveClaude.test.ts` liest das installierte Manifest und muss auf
  die neue SDK-/`claudeCodeVersion` umgestellt werden (rot ist hier erwartet).

## 2. Typecheck

- `pnpm typecheck` (`tsc -b`). Typfehler zeigen geänderte Typings: `SDKMessage`-Union,
  `Options`, `Query`-Methoden, `canUseTool`-Optionen, `PermissionResult`.
- Besonders prüfen (Abweichungen aus `docs/sdk-findings.md`): untypisierte Felder, die wir tolerant
  lesen (`command_lifecycle`, `system/session_title_changed`, `decisionReasonType`,
  `initializationResult().pid`, `getContextUsage().autocompactSource`, WP-64: `Query.enableRemoteControl`/
  `getSettings().effective.remoteControlAtStartup`, `system/bridge_state`, `isReplay`-Prompts mit
  `origin human`, WP-65: `Query.generateSessionTitle`, `usage_EXPERIMENTAL_…`, `backgroundTasks`,
  WP-66: `Query.askSideQuestion`, `cancelAsyncMessage`, `system/control_request_progress`,
  WP-67: `Query.getStatus`, `getMemoryDialog`, `getSkillsDialog`, `getHooksListing`,
  `listPermissionRules`, `exportConversation`, `reloadSkills`/`reloadPlugins` (Antwortformen in
  `docs/wp/WP-67.md` §3, Parser `backend/sessionInfo.ts`),
  `system/task_summary`/`post_turn_summary` …) – sind sie jetzt typisiert
  oder umbenannt? Die SDK-Grenze ist `src/server/backend/sdkBackend.ts` (`SdkQueryHandle`),
  `sdkOptions.ts` und `src/server/sessions/normalizer/sdk-schemas.ts` (zod, tolerant).
- `@shared` kennt keine SDK-Typen – ein SDK-Upgrade ändert **nie** die Contracts direkt; nötige
  Contract-Änderungen gehen als Wunsch an den Koordinator.

## 3. Fixture-Tests (ohne Live-Aufruf)

- `pnpm exec vitest run test/fixtures/sdk src/server/sessions/normalizer src/server/backend`
  (Fixture-Format, Normalizer-Snapshots, FakeBackend/SdkBackend mit Mocks), danach `pnpm check`.
- Die vorhandenen Fixtures stammen aus dem alten SDK: grün heißt nur „alte Daten werden weiter
  verstanden“. Rot im SdkBackend-Mock-Test heißt meist: die Mocks bilden eine geänderte API nicht ab.
- `pnpm e2e` (FakeBackend, kein Live-Aufruf) muss grün bleiben.

## 4. Neu aufzeichnen (live, nur mit Freigabe)

- `pnpm record --list` zeigt die Szenarien, `PARALLAX_LIVE=1 pnpm record all` zeichnet alle neu auf
  (Haiku, Scratch-Ordner `%TEMP%\parallax-spike-<stamp>`, Guards aus ADR-011: Abo-Login,
  `apiKeySource: none`, Abbruch bei Auth-/Billing-Fehler und > 2 USD gesamt).
- **Vor dem Lauf** das Budget bewusst zurücksetzen (`.recordings/spike-state.json`, ADR-011 „Folgen“)
  und `pnpm record --stats` notieren. Die Datei liegt im jeweiligen Checkout bzw. Worktree; ein frischer
  Worktree beginnt bei 0.
- Ist die Freigabe kleiner als der harte Guard (2 USD), das Budget für den Lauf senken:
  `PARALLAX_RECORD_BUDGET_USD=<usd>` (Wert in (0, 2]; ungültig → Abbruch vor dem ersten Scratch-Ordner).
  Live-Smoke und Aufnahme teilen sich die Freigabe; der Smoke hat ein eigenes Budget (Schritt 7).
- `record all` zeichnet alle Szenarien aus `pnpm record --list` auf. `interrupt-requesting` ist kein
  Szenario (erster Interrupt-Lauf aus WP-01) und bleibt bei einer Neuaufzeichnung unverändert (Header
  zeigt die alte Version).
- Danach Tests mit aufgezeichneten Werten nachziehen (Session-/Tool-IDs, `seq`-Belege, Anzahl Messages,
  Plan-Dateiname, Titel). Betroffen waren zuletzt `backend/history/parse.test.ts`,
  `backend/fake/{history,testing}.test.ts`, `backend/fakeBackend.test.ts`,
  `sessions/{brokerRules,mirror}.test.ts` und `sessions/{engine,fixtures}.integration.test.ts`.
- Rohdaten bleiben in `.recordings/` (git-ignoriert, persönliche Daten); die bereinigten Fixtures
  landen in `test/fixtures/sdk/*.jsonl`. Nach dem Lauf `git diff --stat test/fixtures` und eine
  Stichprobe auf persönliche Daten (`<USER>`/`<EMAIL>`-Platzhalter vorhanden, kein Klartext).
- Plan-Modus kann mit Haiku auf ein anderes Modell wechseln (Findings Punkt 6, WP-22: Sonnet 5.5) –
  das Szenario `plan-mode` ist das teuerste (11.11.2026: 0,15 von 0,20 USD der ganzen Aufnahme).
- **Rückbau nach dem Lauf** (außerhalb des Repos, nur nachweislich eigene Daten): Scratch-Ordner
  `%TEMP%\parallax-spike-<stamp>`; Transkriptordner `~/.claude/projects/*-Temp-parallax-spike-<stamp>-work-*`
  (`cwd` in den Transkripten prüfen; `clear-rename` mit kleinem Laufwerksbuchstaben `c--…`); CLI-Task-Ordner
  `%TEMP%\claude\<hash>\<session-id>` mit den Session-IDs aus `spike-state.json`. Die Plan-Datei unter
  `~/.claude/plans/` und den Projekteintrag in `~/.claude.json` nur aufführen.

## 5. Snapshot-Diff

- `pnpm exec vitest run src/server/sessions -u` aktualisiert die Datei-Snapshots
  (`src/server/sessions/normalizer/__snapshots__/{live,history,context,synthetic}/*.json` und
  `src/server/sessions/status/__snapshots__/*.json`), danach
  `git diff -- src/server/sessions/normalizer/__snapshots__ src/server/sessions/status/__snapshots__` lesen.
  Vorher die alten Snapshots sichern; ein Strukturvergleich je Fixture (Item-Arten, Tool-Status,
  Signale, Message-Typen, Turn-Ergebnisse) trennt Modellvarianz von echten Änderungen schneller als
  der Text-Diff:
  - neue/verschwundene Items oder Item-Arten (`kind`), geänderte Status-Signale, Kosten-/Usage-Felder,
  - `unknownCounts` je Snapshot (siehe 6),
  - Text-Unterschiede durch das Modell sind normal (neue Aufzeichnung), Struktur-Unterschiede nicht.
- Jede strukturelle Abweichung: Ursache klären (SDK geändert? Normalizer-Lücke?), im WP-Bericht
  dokumentieren; Normalizer-Änderungen sind WP-12-Besitz.

## 6. Zähler unbekannter Typen und Validierungs-Logs

- **Normalizer:** `unknownCounts` (Schlüssel wie `system/<subtype>`, `invalid:assistant`,
  `assistant/block:<typ>`, `command_lifecycle/<state>`, `permissionMode:<wert>`) – in den Snapshots
  und live im Session-Detail (`detail.unknownCounts`, WS `session.snapshot`/`detail.patch`). Jeder
  neue Schlüssel ist ein Kandidat für Normalizer/Contract (Findings „Beobachtete Message-Typen“
  ergänzen).
- **Server-Validierung** (`--validate=log`, Default, ADR-063): ausgehende Werte, die dem Contract
  nicht entsprechen, werden verworfen und als `error`-Zeile „invalid outgoing value dropped“ bzw.
  „invalid transcript line dropped“ (mit `count`) geloggt (`PARALLAX_HOME\logs\parallax.*.log`).
  Ziel: **0**. Zählen z. B. mit
  `Select-String -Path <home>\logs\parallax.*.log -Pattern 'invalid (outgoing value|transcript line) dropped'`.
- **Client:** `counters.invalidMessages` am Verbindungsindikator (`data-invalid-messages`, R3-05).

## 7. Live-Smoke (nur mit Freigabe)

```powershell
$env:PARALLAX_LIVE='1'; pnpm e2e e2e/live      # ≈ 1,5 min, ≈ 0,01 USD (Haiku)
```

- `e2e/live/live.spec.ts` (WP-22): echter Server-Build mit `--backend=sdk`, Temp-Home, Port 0,
  `--validate=log`, `ANTHROPIC_MODEL=haiku`; startet nicht, wenn `ANTHROPIC_API_KEY`/
  `_AUTH_TOKEN`/`_BASE_URL` gesetzt sind; prüft nach dem ersten Turn `apiKeySource: none` und Haiku
  (sonst Abbruch aller weiteren Fälle), Budget je Prompt (`PARALLAX_LIVE_BUDGET_USD`, Default 0,50).
- Abläufe: angezeigte CLI-Version = `claude --version`; Permission „Einmal erlauben“ → echte Datei;
  AskUserQuestion; Stop während eines laufenden Tools; Reload mit offener Karte; keine
  Validierungs-Drops im Server-Log; sauberes Ende (Exit, Lockfile weg, keine Kindprozesse, keine
  Fehlerzeile im Log).
- Ohne `PARALLAX_LIVE=1` ignoriert `playwright.config.ts` den Ordner `e2e/live` (zusätzlich
  überspringt sich die Datei selbst) – `pnpm e2e` bleibt ohne Live-Aufruf.
- Artefakte in `test-results/` (git-ignoriert): `server-live.log`, `live-cost.txt` und
  `unknown-counts.json` (im Ausgabeordner des letzten Tests, `test-results/live-live-real-SDK-data-…/`).
  Transkripte der Live-Sessions entstehen unter `~/.claude/projects/C--…-Temp-parallax-live-e2e-*`,
  CLI-Task-Ordner unter `%TEMP%\claude\<hash>\<session-id>` (nicht im Repo, nach dem Lauf löschen;
  die Session-ID steht im Namen der Transkriptdatei). 11.11.2026: 6/6 in 25 s, 0,0054 USD.
- Für eine vollständige Abnahme zusätzlich die Checkliste aus `docs/wp/R3.md` („Checkliste WP-22“)
  bzw. das Protokoll in `docs/wp/WP-22.md` durchgehen (Notifications, Doppelstart, harter Abbruch,
  „Server beenden“ – nicht automatisiert).

## Nach WP-61 bei jedem CLI-Upgrade prüfen (ADR-155, ADR-156)

- `init.tools` (auch deferred) auf `TodoWrite`/`TaskCreate`: tauchen sie auf, `todoFeatureEnabled` wieder
  erwägen (ADR-156) und die Aufgabenleiste live prüfen (WP-61 B7/B25). Seit WP-62 meldet `pnpm cli-check`
  das automatisch (Abweichung „task tools offered again“).
- `@`-Regel der CLI: Trenner vor `@` (2.1.322: `\s` und 。、？！; Anführungsform `@"…"`) mit
  `neutralizeAtMentions` (`sessions/summary.ts`) und der Nachbildung in `summary.test.ts` abgleichen; Live-Fall:
  Plan mit `@README.md` → „Mit frischem Kontext umsetzen“ → kein Datei-Attachment/Read im CLI-JSONL (B19).
- Frischer Kontext: kommt das `result` des abgewiesenen Planungs-Turns innerhalb von `freshContextResultMs`
  (Kosten der alten Unterhaltung > 0, keine Zeile „no result of the denied turn“)?
- Server-Log mit `--log-level=debug`: Zeile `first result: credential expiry` je Prozess (B15).

## Abschluss

- WP-Bericht mit: alte/neue SDK- und CLI-Version, Peer-Ranges, Snapshot-Diff (Zusammenfassung),
  neue `unknownCounts`-Schlüssel, Anzahl Validierungs-Drops, Live-Smoke-Ergebnis, Verbrauch.
- `docs/sdk-findings.md` um neue Beobachtungen ergänzen (Kopfzeile „Stand“ mit Versionen).
- CLAUDE.md „Stack“ (exakte SDK-Version), der Versionskommentar bei `ignoredOptionalDependencies` in
  `pnpm-workspace.yaml` und ggf. ADR durch den Koordinator.
