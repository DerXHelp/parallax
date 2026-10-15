# SDK-Upgrade-Prozess (`@anthropic-ai/claude-agent-sdk` und `claude`-CLI)

Plan B „SDK-Upgrade-Prozess“ (`docs/plan.md`): *Version anheben → typecheck → Fixture-Tests → neu
aufzeichnen → Snapshot-Diff → Zähler für unbekannte Message-Typen prüfen → Live-Smoke.* Diese Datei
beschreibt die Schritte für dieses Repo. Stand: WP-22 (15.10.2026, SDK 0.3.296, CLI 2.1.300).

Grundregeln: Das SDK ist **exakt** gepinnt (`CLAUDE.md` „Stack“); ein Upgrade ist ein eigenes
Arbeitspaket mit Koordinator-Freigabe (`package.json`/Lockfile sind tabu). Live-Schritte (Schritt 4
und 7) brauchen eine **Nutzer-Freigabe** (Abo-Login, Haiku, Budget, ADR-011) – ohne Freigabe endet
der Prozess nach Schritt 3 mit „live offen“.

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
  installierte `claude` reicht (`agent sdk … (expects claude >= …)`).

## 2. Typecheck

- `pnpm typecheck` (`tsc -b`). Typfehler zeigen geänderte Typings: `SDKMessage`-Union,
  `Options`, `Query`-Methoden, `canUseTool`-Optionen, `PermissionResult`.
- Besonders prüfen (Abweichungen aus `docs/sdk-findings.md`): untypisierte Felder, die wir tolerant
  lesen (`command_lifecycle`, `system/session_title_changed`, `decisionReasonType`,
  `initializationResult().pid`, `getContextUsage().autocompactSource` …) – sind sie jetzt typisiert
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
  und `pnpm record --stats` notieren.
- Rohdaten bleiben in `.recordings/` (git-ignoriert, persönliche Daten); die bereinigten Fixtures
  landen in `test/fixtures/sdk/*.jsonl`. Nach dem Lauf `git diff --stat test/fixtures` und eine
  Stichprobe auf persönliche Daten (`<USER>`/`<EMAIL>`-Platzhalter vorhanden, kein Klartext).
- Plan-Modus kann mit Haiku auf ein anderes Modell wechseln (Findings Punkt 6, WP-22: Sonnet 5.5) –
  das Szenario `plan-mode` ist das teuerste.

## 5. Snapshot-Diff

- `pnpm exec vitest run src/server/sessions/normalizer -u` aktualisiert die Datei-Snapshots
  (`src/server/sessions/normalizer/__snapshots__/{live,history,synthetic}/*.json`), danach
  `git diff -- src/server/sessions/normalizer/__snapshots__` lesen:
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
- Artefakte in `test-results/` (git-ignoriert): `server-live.log`, `live-cost.txt`. Transkripte der
  Live-Sessions entstehen unter `~/.claude/projects/C--…-Temp-parallax-live-e2e-*` (nicht im Repo,
  bei Bedarf von Hand löschen).
- Für eine vollständige Abnahme zusätzlich die Checkliste aus `docs/wp/R3.md` („Checkliste WP-22“)
  bzw. das Protokoll in `docs/wp/WP-22.md` durchgehen (Notifications, Doppelstart, harter Abbruch,
  „Server beenden“ – nicht automatisiert).

## Abschluss

- WP-Bericht mit: alte/neue SDK- und CLI-Version, Peer-Ranges, Snapshot-Diff (Zusammenfassung),
  neue `unknownCounts`-Schlüssel, Anzahl Validierungs-Drops, Live-Smoke-Ergebnis, Verbrauch.
- `docs/sdk-findings.md` um neue Beobachtungen ergänzen (Kopfzeile „Stand“ mit Versionen).
- CLAUDE.md „Stack“ (exakte SDK-Version) und ggf. ADR durch den Koordinator.
