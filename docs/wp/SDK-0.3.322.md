# SDK-0.3.322 – Agent SDK 0.3.296 → 0.3.322 (passend zu `claude` 2.1.322)

> Koordinator, 11.11.2026. Nutzerauftrag: „aktualisiere die verwendete SDK, sodass die zur aktuellen
> Version passt“. Feature-Branch `feature/sdk-0.3.322` (von `main` = `53d23c6`), Worktree
> `.worktrees/sdk-0.3.322`, Branch `wp/sdk-0.3.322`. Ablauf: `docs/sdk-upgrade.md` (Schritte 1–7).

## 1. Ausgangslage

- Installiert: `claude` **2.1.322** (zuletzt live geprüft: 2.1.300 in WP-41/A18). Gepinnt:
  `@anthropic-ai/claude-agent-sdk` **0.3.296** (`claudeCodeVersion` 2.1.296).
- Ziel: **0.3.322** (`latest`, veröffentlicht 10.11.2026 01:57 UTC, also älter als `minimumReleaseAge`
  1 Tag), `claudeCodeVersion` **2.1.322**. Peer-Ranges unverändert (`zod ^4.0.0`,
  `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`) – trotzdem gegen den Lockfile prüfen.
- Bekannt und **nicht** Teil dieses Pakets: 2 E2E-Fälle (`phase2-lifecycle.spec.ts:34`,
  `phase2-navigation.spec.ts:157`) sind seit dem Edge-Update 155 → 157 auch auf `main` rot; Fix läuft
  parallel in `fix/e2e-edge157` (`docs/wp/FIX-E2E-EDGE157.md`). Im eigenen E2E-Lauf diese zwei Fälle
  ausweisen, nicht selbst beheben. Der parallele Fix nutzt ebenfalls Playwright/Edge (Last möglich).

## 2. Freigaben (Nutzer, 11.11.2026)

- **Koordinator-Freigabe** für `package.json` und `pnpm-lock.yaml`: nur die SDK-Version (exakt, `-E`);
  weitere Abhängigkeitsänderungen nur, wenn das SDK sie zwingend verlangt → vorher `BLOCKED`/Wunsch.
- **Live-Freigabe** für Schritt 4 (`pnpm record`, Neuaufzeichnung aller Szenarien) und Schritt 7
  (Live-Smoke `e2e/live`): Abo-Login (kein API-Key; startet nicht, wenn `ANTHROPIC_API_KEY`/
  `_AUTH_TOKEN`/`_BASE_URL` gesetzt), **Haiku**, Mini-Prompts, Scratch-Ordner unter `%TEMP%`, Temp-Home,
  **Budget ≤ 1 USD gesamt** (Aufnahme + Smoke; Guard des Recorders entsprechend setzen bzw. vorher
  `pnpm record --stats` notieren und mitrechnen). Bei Auth-/Billing-Fehler (`credits_required` o. ä.)
  oder `apiKeySource` ≠ `none` **sofort stoppen** und `BLOCKED` melden.
- **Weiter verboten:** `pnpm dev:live`, Desktop-Bedienung per Skript (Klicks, Tastatur, Fenster-Fokus,
  Bildschirmfotos, UI Automation außerhalb von Playwright, Prozessspeicher; Nutzer-Regel 18.10.2026),
  `%LOCALAPPDATA%\Parallax` anfassen.
- Rückbau: Scratch-Ordner löschen; Transkriptordner unter `~/.claude/projects/`, die **nachweislich** zu
  den eigenen Scratch-Ordnern gehören, löschen und im Ergebnis auflisten – sonst nichts in `~/.claude`.

## 3. Auftrag

Schritte 1–7 aus `docs/sdk-upgrade.md` vollständig:
1. Version anheben (`pnpm add -E @anthropic-ai/claude-agent-sdk@0.3.322`, Gegenprobe
   `pnpm install --frozen-lockfile`), Peer-Ranges, **keine** `claude-agent-sdk-win32-*` in `node_modules`,
   `pnpm preflight` zeigt `expects claude >= 2.1.322` ohne Warnung.
2. Typecheck; geänderte Typings an der SDK-Grenze nachziehen (`backend/sdkBackend.ts`, `sdkOptions.ts`,
   `sessions/normalizer/sdk-schemas.ts`). Prüfen, ob bisher untypisiert/tolerant gelesene Felder
   (Liste in `docs/sdk-upgrade.md` §2 und `docs/sdk-findings.md`) jetzt typisiert, umbenannt oder entfallen sind.
3. Fixture-Tests, `pnpm check`, `pnpm e2e` (FakeBackend).
4. Neu aufzeichnen (live), Fixtures bereinigt nach `test/fixtures/sdk/*.jsonl`; Stichprobe auf persönliche
   Daten (Platzhalter `<USER>`/`<EMAIL>`, kein Klartext von Nutzername, E-Mail, Pfaden mit Nutzernamen).
5. Snapshot-Diff (`vitest -u` für `src/server/sessions/normalizer/__snapshots__`): jede **strukturelle**
   Abweichung erklären (SDK geändert? Normalizer-Lücke?) und – falls nötig – Normalizer/Status anpassen.
6. `unknownCounts` und Validierungs-Drops: neue Schlüssel bewerten; Ziel 0 Drops.
7. Live-Smoke `$env:PARALLAX_LIVE='1'; pnpm e2e e2e/live` (6/6).

Zusätzlich: Gibt es in 0.3.297 … 0.3.322 **neue Fähigkeiten**, die für Parallax relevant sind (z. B. neue
`Query`-Methoden, Optionen, Message-Typen, Steuerbefehle), nur **notieren** (Ergebnis „Neue
SDK-Fähigkeiten“) – nicht einbauen.

**Besitz-Pfade:** `package.json`/`pnpm-lock.yaml` (nur die SDK-Version), `src/server/backend/**` (ohne
`types.ts`/`fixture.ts`), `src/server/sessions/**` (ohne `ports.ts`; Normalizer, Status, Snapshots),
`src/server/claude/**` (ohne `ports.ts`; nur falls Versionsregel/Preflight es verlangen),
`scripts/record/**`, `scripts/preflight.ts`, `test/fixtures/sdk/**`, `e2e/live/**`,
`docs/sdk-findings.md` (anhängen, Kopfzeile „Stand“), `docs/sdk-upgrade.md` (Stand-Zeile, ggf.
Präzisierungen), diese Datei. **Tabu:** `src/shared/**`, alle `ports.ts`, `backend/{types,fixture}.ts`,
`src/web/**`, `e2e/**` außer `e2e/live/**`, `pnpm-workspace.yaml`, `CLAUDE.md` (die SDK-Version in
„Stack“ trägt der Koordinator nach), `docs/progress.md`, `docs/decisions.md`. Contract-/Port-Bedarf →
Bericht „SCHNITTSTELLEN/CONTRACT-ABWEICHUNGEN“ bzw. `BLOCKED`.

**Regeln:** `CLAUDE.md` vollständig. Lange Läufe (`pnpm check`, `pnpm e2e`, `pnpm record`) im
Hintergrund mit Ausgabe in Dateien. Gestartete Prozesse am Ende beenden (keine verwaisten `claude.exe`,
Edge, Server).

## 4. Abnahme

- `pnpm install --frozen-lockfile` ok; keine Plattform-Binaries; `pnpm preflight` ok.
- `pnpm check` grün (Testanzahl nennen), `pnpm build` grün.
- `pnpm e2e` grün bis auf die zwei bekannten Edge-157-Fälle (§1), ausgewiesen.
- Live: Aufnahme vollständig, Snapshot-Diff erklärt, 0 Validierungs-Drops, Live-Smoke 6/6; Kosten
  (USD, Anzahl Sessions/Requests) im Ergebnis.

**Commit:** lokal auf `wp/sdk-0.3.322` (Deutsch, mehrere `-m`, kein Heredoc), nicht pushen, nicht mergen.
Bericht im Format aus `CLAUDE.md`.

## 5. Ergebnis

Subagent, 11.11.2026. Alle sieben Schritte erledigt, live mit Freigabe (Abo-Login, Haiku,
`apiKeySource: none`, keine Auth-/Billing-Fehler). **Live-Kosten gesamt 0,2005 USD** (Budget ≤ 1 USD).

### 5.1 Versionen und Abhängigkeiten (Schritt 1)

| | alt | neu |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.296 | **0.3.322** (exakt) |
| `claudeCodeVersion` (Manifest) | 2.1.296 | **2.1.322** |
| `claude` installiert / in Fixtures | 2.1.322 / 2.1.300 | 2.1.322 / 2.1.322 |
| `engines.node` des SDK | `>=18.0.0` | `>=18.14.0` (Node 26 erfüllt) |

- Peer-Ranges unverändert und erfüllt: `zod ^4.0.0` (4.6.7), `@anthropic-ai/sdk >=0.93.0` (0.133.0),
  `@modelcontextprotocol/sdk ^1.29.0` (1.32.1). Lockfile: nur der SDK-Eintrag (Specifier, Version,
  Integrity, `engines`); `pnpm install --frozen-lockfile` ok.
- `optionalDependencies` des SDK: dieselben 8 Plattform-Pakete wie in 0.3.296, `ignoredOptionalDependencies`
  passt weiter; keine `claude-agent-sdk-*`-Binaries in `node_modules`.
- `pnpm preflight --home=<Temp>`: `agent sdk … 0.3.322 (expects claude >= 2.1.322)`, `claude … 2.1.322`,
  Login `claude.ai`/`firstParty`, Ergebnis OK (0 Fehler; 1 Warnung zum Virenscanner mit Web-Traffic-Scan,
  umgebungsbedingt und bekannt).

### 5.2 Typ-Änderungen und Anpassungen (Schritt 2)

- `tsc -b` ohne Fehler; an der SDK-Grenze (`sdkBackend.ts`, `sdkOptions.ts`, `sdk-schemas.ts`) war **kein**
  Code nötig. `sdk.d.ts`: ≈ 580 Zeilen neu, 80 entfallen, überwiegend Doku-Kommentare.
- Die tolerant gelesenen Felder sind **weiter untypisiert**: `command_lifecycle`,
  `system/session_title_changed`, `getContextUsage().autocompactSource`, `initializationResult().pid`.
  `PermissionUpdate` ist unverändert. Nachgezogen wurden nur Versionskommentare (`sdk-schemas.ts`,
  `permissionRequest.ts`, `resolveClaude.ts`, `types.test.ts`) und der Manifest-Test
  (`resolveClaude.test.ts`: 0.3.322 / 2.1.322).
- Neu in den Typen: `SDKSessionWritesLostMessage`, `SDKControlSetHasSubscribersRequest`,
  `BUILTIN_TOOL_NAMES`/`LEGACY_TOOL_NAME_ALIASES` (alpha) sowie drei neue `SDKStartupFailureReason`:
  `config_file_invalid`, `initialize_not_first` und `sandbox_required_unavailable`. Felder einzeln in 5.8.
  In `sdk-tools.d.ts` entfällt die Read-Ergebnisvariante `file_unchanged`; Parallax liest sie nicht.
- Folgen ohne Codeänderung: Die neuen Startgründe landen über den Fallback bei `CLAUDE_STARTUP_FAILED`
  (mit `params.reason`). `system/session_writes_lost` würde als unbekannter Typ gezählt; ausgelöst
  wurde es nicht.

### 5.3 Recorder

- Neu ist `PARALLAX_RECORD_BUDGET_USD` (`scripts/record/context.ts`). Die Variable **senkt** den harten
  2-USD-Guard für einen Lauf. Erlaubt ist ein Wert in (0, 2]; ein ungültiger Wert bricht ab, bevor ein
  Scratch-Ordner entsteht. Test: `scripts/record/context.test.ts` (7). Anlass war die Freigabe
  „≤ 1 USD gesamt“: Die Aufnahme lief mit Guard 0,70 USD.
- `.recordings/spike-state.json` war im frischen Worktree leer, das Budget startete also bei 0.

### 5.4 Aufnahme und Snapshot-Diff (Schritte 3–5)

- **Vor** der Aufnahme mit den alten Fixtures: `pnpm check` grün, `pnpm e2e` 44/45. Rot war nur der
  bekannte Fall `phase2-lifecycle.spec.ts:34`; `phase2-navigation.spec.ts:157` lief in diesem Lauf grün.
- `PARALLAX_LIVE=1 PARALLAX_RECORD_BUDGET_USD=0.7 pnpm record all` (Stamp `20261111-182054`) ergab
  10 Sessions mit 28 `result`s, alle ok, 0 Waisen. 11 Fixtures sind neu, `history` stammt aus den Calls.
- `interrupt-requesting` ist kein eigenes Szenario: Das Fixture ist der erste Interrupt-Lauf aus WP-01
  (WP-01.md). Es bleibt eine Aufnahme mit 0.3.296 / 2.1.300, was der Header ausweist; die Tests sind grün.
- Stichprobe auf persönliche Daten: kein Nutzername, Rechnername oder E-Mail-Klartext. Platzhalter:
  `<HOME>` 181, `<SCRATCH>` 319, `<EMAIL>`/`<ORG>` je 2, `<SIGNATURE>` 35. `fixtures.test.ts` ist grün.
- **Snapshot-Diff:** 28 Datei-Snapshots aktualisiert (`normalizer/__snapshots__/{live,history,context}`,
  `status/__snapshots__`). Ein Strukturvergleich je Fixture (Item-Arten, Tool-Status, Signale,
  Message-Typen, `unknownCounts`/`ignoredCounts`, Turn-Ergebnisse) zeigt **keine Normalizer-Lücke und
  keinen neuen Message-Typ**:
  - `ask-user-question`, `plan-mode`, `queue-priority` und `resume` sind strukturell gleich.
  - `auth-probe` hat ein `context_estimate` weniger: `message_start` trägt jetzt schon die finalen
    `output_tokens` (4 statt 1), deshalb unterdrückt das Dedup in `emitEstimate` das gleiche Total bei
    `message_delta`. Verhalten korrekt.
  - `clear-rename` hat neu `system/background_tasks_changed` (`tasks: []`) direkt nach
    `conversation_reset` bei `/clear`, also Signal `background_tasks` und Detail `backgroundTasks`. Der
    Typ ist bekannt; die CLI meldet bei `/clear` jetzt die geleerte Task-Liste. Ein `thinking`-Item mehr
    ist Modellvarianz.
  - In `interrupt` trifft die dritte Phase („interrupt-during-stream“) jetzt wirklich den Stream:
    `error_during_execution`/`aborted_streaming`, Text-Item `aborted`, `system/interrupted`. Bisher kam
    `success`, weil der Turn schon fertig war. Neu sind außerdem `task_started`/`task_notification`
    (`local_bash`, `is_backgrounded:false`, `stopped`) für die laufende Bash. Das ist ein Zeitpunkteffekt:
    Den gleichen Ablauf zeigte `queue-priority` schon mit 0.3.296. Die Abdeckung ist dadurch besser.
  - `permissions-rules` hat 4 statt 8 Tool-Calls: Haiku wich nach den verweigerten Wiederholungen nicht
    mehr auf PowerShell aus. Der Befund aus Punkt 3 bleibt (beide Wiederholungen werden wieder gefragt,
    `Bash:denied=2`).
  - `permissions` hat einen `Read` vor `Edit`, `subagent` ein `thinking` weniger: beides Modellvarianz.
- Die Testanpassungen betreffen nur aufgezeichnete Werte: Session-/Tool-IDs, `seq`-Belege,
  Message-Anzahl 33 → 36, Plan-Datei, Titel und `lastModified`. Betroffen sind 8 Testdateien unter
  `backend/` und `sessions/`.

### 5.5 `unknownCounts` und Validierungs-Drops (Schritt 6)

- `unknownCounts` ist in **allen** Snapshots und live `{}`; es gibt keine neuen Schlüssel. Auch
  `ignoredCounts` ist unverändert.
- Validierungs-Drops: **0** (Live-Smoke, `--validate=log`, Server-Log ohne `error`/`warn`-Zeilen).

### 5.6 Live-Smoke (Schritt 7) und Kosten

- `PARALLAX_LIVE=1 PARALLAX_LIVE_BUDGET_USD=0.3 pnpm e2e e2e/live`: **6/6** in 24,9 s, 1 Session,
  `claude` sauber beendet (Exit 0, erwartet), 0,0054 USD.

| Lauf | Sessions | `result`s | API-Antworten | USD |
|---|---|---|---|---|
| Aufnahme (Haiku) | 10 | 28 | 47 (inkl. Plan-Modus) | 0,0487 |
| Aufnahme (Sonnet 5.5 im Plan-Modus, bekannt: Findings Punkt 5) | – | – | – | 0,1463 |
| Live-Smoke | 1 | – | – | 0,0054 |
| **Summe** | **11** | | | **0,2005** |

### 5.7 Rückbau

Gelöscht wurde nur, was nachweislich aus den eigenen Läufen stammt. Den Nachweis liefern das `cwd` in
den Transkripten bzw. die Session-IDs aus `spike-state.json` und `server-live.log`.
- `%TEMP%\parallax-spike-20261111-182054` (Scratch). `%TEMP%\parallax-live-e2e-*` hatte der Smoke schon
  selbst entfernt.
- `~/.claude/projects/` (10 Ordner):
  `C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261111-182054-work-{auth-probe,permissions,`
  `permissions-rules,ask-user-question,plan-mode,queue-priority,interrupt,subagent}`,
  `c--Users-<USER>-AppData-Local-Temp-parallax-spike-20261111-182054-work-clear-rename` und
  `C--Users-<USER>-AppData-Local-Temp-parallax-live-e2e-0FroFn-01-permission`.
- `%TEMP%\claude\{01b562800deacd10,05f8a0c8b81875ce,4da98238ef846517,78152bdee67430e6,f3c955d1965df7e6,8a0f09f9b82977d4}`:
  CLI-Task-Ordner mit je genau einer eigenen Session-ID. Sie liegen außerhalb von `~/.claude`.
- **Nicht gelöscht**, nur aufgeführt: die Plan-Datei `~/.claude/plans/plan-how-to-create-jolly-nest.md`
  (Szenario `plan-mode`) und der Eintrag der CLI in `~/.claude.json` (Projektliste).
- `.recordings/20261111-182054/` (Rohdaten) und `spike-state.json` bleiben git-ignoriert im Worktree.
- Prozesse: keine eigenen `claude.exe`, Edge- oder Server-Prozesse übrig. Die laufenden
  Playwright-/Edge-Prozesse gehören zum parallelen `fix-e2e-edge157`.

### 5.8 Neue SDK-Fähigkeiten 0.3.297 … 0.3.322 (nur notiert, nicht eingebaut)

- **Login-Ablauf:** `result.credential_expires_at` (ISO-Zeitpunkt; bei success und error). Damit wäre
  eine Warnung vor dem Ablauf des Abo-Logins möglich.
- **Plattenplatz:** `system/session_writes_lost` (`ENOSPC`/`EDQUOT`, `lost: transcript|global_config`,
  `transcript_session_ids`) wird höchstens einmal beim Beenden gesendet. Kandidat für einen Hinweis
  „Verlauf unvollständig“.
- **AskUserQuestion:** Capability `ask_user_question_unanswered_v1` mit den Ausgängen `dismissed`,
  `skipped` und `replied_in_chat`. Damit lässt sich eine Frage ohne Antwort schließen, passend zu den
  Fragekarten.
- **Weitere neue Capabilities in `init`:** `interrupt_requeue_taken_v1`, `lifecycle_wakeup_source_v1`,
  `mcp_call_result_not_for_model_v1` und `mcp_call_check_permissions_v1`.
- **Neue `init`-Felder:** `original_cwd`, `additional_directories`, `ultrathink_available`,
  `ultrathink_typed_raises` und `user_message_uuids`.
- **Context:** Die Kategorien von `getContextUsage()` haben eine stabile `id` (`system_prompt`,
  `system_tools`, `mcp_tools`, `memory_files`, `skills`, `messages` …); Parallax ordnet bisher über den
  englischen Namen zu. Neu sind außerdem `mcpInstructions` je Server und die Plugin-Herkunft (`pluginId`, `path`) bei
  Skills und Agents.
- **Kosten:** `ModelUsage.cacheCreationEphemeral5mInputTokens` und `…1hInputTokens`.
- **Wiederanmeldung:** `pending_elicitation_requests` (wie `pending_permission_requests`) für Clients,
  die später dazukommen.
- **Hooks und Plugins:** Hook-Matcher `onFailure: 'continue'|'block'` mit `hook_on_failure_supported` im
  Initialize-Reply; `reloadPlugins({ addPlugins })`.
- **MCP:** Tool-Policy `tools` auch für SDK-Server; `mcp_call` mit `check_permissions` bzw.
  `result_not_for_model`.
- **Steuerung:** `set_has_subscribers` (nur mit `CLAUDE_CODE_STREAM_EVENT_HOLD_MS`).
- **Settings:** `blockWritesOutsideWorkingDirectories`, `blockReadsExemptPaths`,
  `workingDirectoriesAsGiven`, `denyInsteadOfPrompting` und **`disableWindowsBashCommandSplit`**
  (Windows). PermissionUpdate-`source` kennt zusätzlich `mcpMount`.
- **Modelle:** `supportedModels()` liefert jetzt 14 statt 5 Einträge (Aliase plus volle IDs, `fable`
  neu, `claude-fable-5-1` ohne `[1m]`). `FAKE_MODELS` im FakeBackend bildet weiter den Stand von 2.1.300 ab.

### 5.9 Checks

- `pnpm check` grün: 216 Testdateien, 3799 Tests. `pnpm build` grün.
- `pnpm e2e` (FakeBackend) nach der Neuaufzeichnung: 43/45. Rot waren der bekannte Fall
  `phase2-lifecycle.spec.ts:34` und `transcript.spec.ts:74` (Timeout beim Nachladen älterer Items,
  synthetische Echo-Turns, nicht fixture-abhängig). Der zweite Fall lief vor der Aufnahme grün und
  einzeln wiederholt ebenfalls (`e2e/transcript.spec.ts` 3/3); er ist lastbedingt, weil parallel der
  E2E-Lauf von `fix-e2e-edge157` lief. Der Server-Build für E2E lädt keine `.jsonl`-Fixtures.
  `phase2-navigation.spec.ts:157` lief in beiden Läufen grün.

### 5.10 Wünsche an den Koordinator

- `CLAUDE.md` „Stack“: SDK **exakt 0.3.322**. Kommentar in `pnpm-workspace.yaml` „SDK 0.3.296 declares …“
  auf 0.3.322 setzen (Plattformliste unverändert).
- Optional (Contract): eigene Fehlercodes für die neuen Startgründe (vor allem `config_file_invalid` mit
  Hinweis „Einstellungsdatei prüfen“). Ein Hinweis bei `session_writes_lost`. Eine Warnung vor dem
  Login-Ablauf über `credential_expires_at`.
- Follow-ups (eigene WPs): Context-Kategorien über `id` statt Namen abbilden;
  `ask_user_question_unanswered_v1` für „Frage überspringen“ prüfen; `FAKE_MODELS` und die
  Modellauswahl an die 14 Einträge anpassen; `interrupt-requesting` bei Gelegenheit gezielt neu
  aufzeichnen (Szenario fehlt im Recorder).
