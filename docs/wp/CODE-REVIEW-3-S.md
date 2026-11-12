# Code-Review Phase 3 – Fix-Paket S Engine/Backend

- **Datum:** 12.11.2026. Branch `fix/cr3-s` (Basis `feature/phase-3` `8b54b9c`), Worktree `.worktrees/cr3-s`.
- **Pfade:** `src/server/sessions/**` und `src/server/backend/**`, je ohne `ports.ts`, `backend/types.ts`,
  `backend/fixture.ts` und `README.md` (Plan: `docs/wp/CODE-REVIEW-3.md`; Funde WP61-xx: `docs/wp/WP-61.md` §2.9).
- **Vorgehen je Fund:** erst ein Test gegen den alten Code (rot), dann der Fix (grün); die Tests bleiben als
  Regression (Testname „CR3-0x: …“ bzw. „WP61-0x: …“). Nur FakeBackend, Test-Doubles und virtuelle Uhr – kein
  Live-`claude`.
- **Ressourcen (ADR-154, zwei Pakete parallel):** nur gezielte Läufe (`vitest run <eigene pfade> --maxWorkers=2`,
  `eslint <pfade>`, zweimal `pnpm typecheck`), alle mit Priorität „niedriger als normal“; kein `pnpm check`/
  `build`/`e2e` – die macht der Koordinator beim Merge.
- Keine Contract-/Port-Änderung, keine neuen Fehlercodes, keine neuen Abhängigkeiten.

## Funde

| Nr. | Reproduziert | Fix | Regressionstest | Commit |
|---|---|---|---|---|
| CR3-08 | **nur White-Box.** Rot: der Spy auf `EntryState.prototype.cancelRetry` sah den Aufruf vor dem `SESSION_BUSY` (am 12.11. nochmals gegen den alten `freshContext.ts` geprüft: rot). Der im Review beschriebene Verlust eines Retrys ist **nicht erreichbar**, Begründung unten. | `approveFreshContext`: `s.cancelRetry()` steht nicht mehr vor dem Lock, sondern im Lock nach `assertEntryGate`, `broker.check` und `assertWithoutOtherWork` – erst ein angenommener Request bricht den Retry ab (wie A.10, ADR-131). | `phase3.integration.test.ts`: „CR3-08: refused inside the lock (SESSION_BUSY) → the auto-retry is not touched“ (alt rot, neu grün); Wächter „CR3-08: an accepted request still cancels the auto-retry (once, inside the lock)“ (alt wie neu grün) | `a8a6079` |
| CR3-09 | ja. Rot: zwei `plan.list` hintereinander lasen jedes Mal jede `plans/v<N>.md` voll (`readPlan`-Mitschnitt nicht leer). | Neu `sessions/planIndex.ts`: `withPlanIndex(inner)` umhüllt den `DecisionStore` im Manager (`EngineCoreStores.decisions: PlanIndexedDecisionStore`). Erfolgreiches `savePlan` und ein `readPlan` mit Text merken die Version; `planStored(entryId, version)` beantwortet bekannte Versionen ohne Dateizugriff und liest unbekannte genau einmal. Kein Negativ-Cache (fehlend/unlesbar wird beim nächsten Mal erneut geprüft). `commands.ts` `planStored` nutzt ihn; `plan.read` liest weiter den Text. | `phase3.integration.test.ts`: „CR3-09: plan.list reads a plan file at most once per server run (saved or read before = known)“ (auch nach Neustart: je Version höchstens ein Lesen); `planIndex.test.ts` (4 Tests, `withPlanIndex (CR3-09)`) | `a8a6079` |
| WP61-01 | ja. Rot: `freshContextPrompt` und `implementPlanPrompt(null, …)` enthielten `@README.md`, `@"docs/my notes.md"` usw., die eine Nachbildung der CLI-Regel (aus der CLI 2.1.322) als Datei-Verweise fand; Integrationstest: der gesendete Prompt (`agent.sent`) ebenso. | `summary.ts` `neutralizeAtMentions`: vor genau die `@`, die die CLI expandiert (am Textanfang, nach Whitespace oder nach 。、？！; deckt auch `@"…"` ab), kommt U+200B. Angewendet im ersten Prompt des frischen Kontexts und in der A.10-Freigabe mit Plan im Text. Plan-Datei und `plans/v<N>.md` behalten den Originaltext; sichtbarer Text unverändert, Mail-Adressen und `'@scope/pkg'` unverändert, idempotent. | `summary.test.ts` „WP61-01: `@` in a plan text sent to the CLI“ (4 Tests: Kontrolle der Nachbildung, `freshContextPrompt`, `implementPlanPrompt`, Randfälle/Idempotenz); `phase3.integration.test.ts` „WP61-01: `@` mentions of the plan reach the fresh session neutralized (U+200B); the plan file keeps them“ | `a8a6079` |
| WP61-02 | ja (Code-Stand; Wirkungslosigkeit live in B7/B25 belegt). Rot: 26 Tests in `sdkOptions.test.ts` und 5 in `sdkBackend.test.ts` mit der neuen Erwartung „kein `todoFeatureEnabled`“. | `sdkOptions.ts`: `StartFlagSettings = Pick<Settings, 'autoCompactWindow' \| 'fastMode'>`; `startFlagSettings` liefert `null`, wenn nichts zu setzen ist → ein einfacher Start hat gar keine `settings`-Option mehr, `flagSettingsAfterStart` mit Settings-Datei allein → `null` (kein `applyFlagSettings`). Web unverändert: `detail.todos` und die Aufgabenleiste bleiben für `TodoWrite`/`TaskCreate` aus dem Stream. | `sdkBackend.test.ts` „WP61-02: a settings file alone gets no flag settings after the start (no todoFeatureEnabled)“; angepasste Zeilen in `sdkOptions.test.ts` (`settings` in der Liste der nie gesetzten Optionen, Fast-Modus absent/null → keine `settings`, „only a settings path“ → `null`) | `a8a6079` |
| WP61-03 | ja. Rot: „open decision: …“ – `conversations[0].costUsd` blieb `null`, weil der Prozess vor dem `result` des abgewiesenen Turns geschlossen wurde; „WP61-03: without a result …“ – kein begrenztes Warten (Timeout nach 20 s). | Ohne Contract-Änderung: `SessionRuntime.nextTurnResult()` (erfüllt sich nach dem nächsten verarbeiteten `turn_result` oder dem Prozessende), `lib/timers.ts` `settledWithin` (aus dem Shutdown des Managers herausgezogen). `approveFreshContext` wartet nach `deny + interrupt` höchstens `freshContextResultMs` (Option, Default 3000) auf das `result`, dann `closeRuntime`; Kosten und `lastTurn` laufen über den normalen `turn_result`-Pfad in die alte Unterhaltung. Kommt nichts: `info`-Zeile, Schließen wie bisher. Nur bei offener Karte (abgelaufene Karte: kein Prozess, kein Warten). | `phase3.integration.test.ts`: Zusatz in „open decision: deny + interrupt, outcome, process closed, new conversation without resume, exact first prompt“ (`costUsd` > 0), „WP61-03: without a result of the denied turn the close waits at most freshContextResultMs“; `timers.test.ts` „settledWithin“ (2 Tests) | `a8a6079` |
| WP61-04 | ja. Rot: 2 Tests – keine Log-Zeile. | `sdkBackend.ts`: beim ersten `result` je Prozess eine `debug`-Zeile `first result: credential expiry` mit nur `credentialExpiresAt` (zod pickt `credential_expires_at`, String ≤ 64 Zeichen, sonst `null`); keine weiteren Auth- oder Result-Daten. `SdkBackendDeps.logger?` (Default Server-Logger, Kind `module: 'backend/sdk'`) als Test-Naht. | `sdkBackend.test.ts` „SdkBackend – credential expiry in the log (WP61-04, B15)“: „one debug line at the first result of a process – only the expiry, nothing else of the result“ (exakte Schlüssel), „a result without the field logs null; every process logs its own first result“ | `a8a6079` |
| WP61-07 | ja. Rot: `live.test.ts` (Name wurde zu „Running …“) und `fake/dsl.test.ts`. | `normalizer/live.ts`: `task_progress` übernimmt `description` nicht mehr (nur `summary`, Usage, `subagent_type`); der Name kommt weiter aus `task_started`/`task_updated`. FakeBackend wie die CLI: `taskProgress({activity})` sendet die Tätigkeit als `description`; `fake:background` schickt „Running …“ – damit prüft auch `e2e/phase3-tasks.spec.ts` (erwartet „Fake background research“) den Fix im Browser. | `live.test.ts` „WP61-07: task_progress.description (the current activity) never renames the task“; `fake/dsl.test.ts` (Progress mit `activity`, `task.description` bleibt „Research“) | `a8a6079` |

### CR3-08 – warum der Retry-Verlust nicht erreichbar ist

- Ein Auto-Retry entsteht nur nach einem Absturz **im Leerlauf** (`decideRetry`, ADR-025). Mit offener
  Plan-Karte wartet der Prozess mitten im Turn auf die Antwort – stirbt er, ist das kein Leerlauf-Absturz,
  also kein Retry; die Karte wird `expired`.
- Jeder spätere Start (Prompt, Retry, Fortsetzen) schließt abgelaufene Karten (`startRuntime` →
  `broker.closeExpired`). Eine abgelaufene Karte und ein geplanter Retry bestehen deshalb nie gleichzeitig;
  eine offene Karte bedeutet einen lebenden Prozess, also ebenfalls keinen Retry.
- Der frühe Abbruch war damit in allen erreichbaren Zuständen wirkungslos. Der Fix ist trotzdem umgesetzt
  (Auftrag, und robust gegen spätere Retry-Regeln). Ein erster Test mit abgelaufener Karte und
  Leerlauf-Absturz scheiterte genau daran (Zustand nicht herstellbar) und wurde durch den Spy-Test ersetzt.

## Entscheidungen

1. **WP61-01 – U+200B statt Backticks.** Backticks würden ebenfalls nichts expandieren lassen, ändern aber den
   genehmigten Plantext sichtbar (Code-Formatierung im Transkript; Pfade, die schon in Backticks stehen,
   würden verdoppelt). U+200B ist der Baustein von R5W-03 (Slash-Schutz): unsichtbar, kein `\s` in JS und für
   die CLI-Regel (`[^\s]+`, Trenner `\s。、？！`), wird von `trim()` nicht entfernt. Claude liest den Pfad
   unverändert und kann ihn selbst öffnen. Geschützt werden nur die `@`, die die CLI expandieren würde; andere
   `@` bleiben byte-gleich. Ein eigenes `fake:`-Szenario entfällt: der FakeBackend bildet die CLI-Expansion
   nicht nach und könnte die Wirkung nicht zeigen; der Integrationstest prüft den tatsächlich gesendeten
   Prompt.
2. **CR3-09 – Index in der Engine statt `stat`.** `src/server/lib` hat keinen Existenz-Helfer, und der
   `DecisionStore`-Port (`sync/ports.ts`, eingefroren) kennt nur `readPlan`/`savePlan`; die Datei liegt
   hinter dem Store (`store/decisions.ts`, Paket D). Der Index kennt alles, was dieser Serverlauf gespeichert
   oder gelesen hat; nach einem Neustart liest das erste `plan.list` jede noch unbekannte Version einmal,
   danach nie wieder. Ohne Lesen ginge es nur mit einer Port-Methode (optional angefragt, s. u.).
3. **WP61-03 – begrenztes Warten im Lock (3 s).** Echte Zahlen der CLI statt einer Schätzung aus dem letzten
   `assistant`-Usage. Eine hängende CLI verzögert den frischen Start höchstens um `freshContextResultMs`;
   danach greift das bisherige Verhalten. Ein in dieser Zeit fälliger Retry ist wegen CR3-08 schon
   abgebrochen; weitere `decision.respond` des Eintrags beantwortet der Ablauf weiter mit `SESSION_BUSY`.

## ADR-Vorschläge (für `docs/decisions.md`)

## ADR-155 – Frischer Kontext: Annahme vor Wirkung, `@` neutralisiert, Planungs-Turn mit Kosten
- **Datum/WP:** 12.11.2026, Code-Review Phase 3, Fix-Paket S (CR3-08, CR3-09, WP61-01, WP61-03). Ergänzt
  ADR-147, ADR-148 und ADR-131 (Texte bleiben).
- **Kontext:** „Mit frischem Kontext umsetzen“ brach einen geplanten Auto-Retry schon vor den Prüfungen im
  Lock ab (CR3-08). Die CLI expandiert `@pfad` in jedem Prompt, auch ohne `client_composed`; ein Plantext mit
  `@README.md` erzeugte im ersten Prompt des frischen Kontexts ein Datei-Attachment samt Read (B19). Der
  Prozess wurde direkt nach `deny + interrupt` geschlossen, das `result` des Planungs-Turns kam nie an –
  Kosten und Usage der Planung fehlten (B2/B3, ≈ 0,12 USD). `plan.list` las für `stored` jede Planversion
  voll (CR3-09).
- **Entscheidung:** (1) `cancelRetry` erst im Lock nach Gate, Broker-Prüfung und „ohne Arbeit“. (2) Plantext,
  den Parallax an die CLI schickt (erster Prompt des frischen Kontexts, A.10-Freigabe mit Plan im Text),
  bekommt vor jedes `@`, das die CLI expandieren würde (Textanfang, nach Whitespace oder nach 。、？！), ein
  U+200B (`neutralizeAtMentions`, `sessions/summary.ts`); Plan-Datei und `plans/v<N>.md` bleiben im
  Original. (3) Nach `deny + interrupt` wartet die Engine höchstens `freshContextResultMs` (Default 3000) auf
  das `result` des abgewiesenen Turns, dann schließt sie den Prozess. (4) `plan.list` kennt gespeicherte und
  gelesene Versionen je Serverlauf (`withPlanIndex`) und liest jede höchstens einmal.
- **Folgen:** Die alte Unterhaltung trägt die Kosten der Planung, sofern die CLI das `result` innerhalb der
  Frist liefert (live zu bestätigen). Der erste Prompt enthält unsichtbare U+200B vor geschützten `@`; wer
  ihn aus dem Transkript kopiert, kopiert sie mit. Die CLI-Regel für `@` wird bei jedem CLI-Upgrade geprüft
  (`docs/sdk-upgrade.md`). Umsetzung und Tests: `sessions/{freshContext,summary,runtime,planIndex,commands}.ts`,
  `sessions/lib/timers.ts`, `phase3.integration.test.ts` „CR3-08/CR3-09/WP61-01/WP61-03: …“,
  `summary.test.ts`, `planIndex.test.ts`.

## ADR-156 – Backend nach WP-61: kein `todoFeatureEnabled`, Task-Name nicht aus `task_progress`, Anmeldeablauf im Debug-Log
- **Datum/WP:** 12.11.2026, Code-Review Phase 3, Fix-Paket S (WP61-02, WP61-04, WP61-07). Ersetzt in ADR-149
  den Satz „`todoFeatureEnabled: true` als Flag-Setting (L5)“; ergänzt WP-50 §11 (B15).
- **Kontext:** Mit CLI 2.1.322 bewirkt `todoFeatureEnabled` nichts – weder `TodoWrite` noch `TaskCreate` stehen
  in `init.tools` (auch nicht deferred), mit und ohne Settings-Datei (B7, B25). Mit Settings-Datei löste das
  Flag allein ein `applyFlagSettings` nach dem Start aus. `task_progress.description` ist die aktuelle
  Tätigkeit der CLI („Running …“), nicht der Task-Name, und überschrieb ihn bis nach dem Ende (WP61-07).
  `credential_expires_at` landete nirgends, B15 war nicht ablesbar (WP61-04).
- **Entscheidung:** (1) Parallax sendet `todoFeatureEnabled` nicht mehr; Flag-Settings nur noch
  `autoCompactWindow` (C.1) und `fastMode` (Phase 2), ohne Wert gar keine `settings`-Option bzw. kein
  `applyFlagSettings`. Die Aufgabenleiste bleibt und zeigt `TodoWrite`/`TaskCreate`, sobald die CLI sie
  anbietet. (2) Der Live-Normalizer übernimmt aus `task_progress` nur `summary`, Usage und
  `subagent_type`, nie `description`. (3) Das SdkBackend schreibt beim ersten `result` je Prozess eine
  `debug`-Zeile mit nur `credentialExpiresAt` (ISO-String oder `null`).
- **Folgen:** Beim nächsten CLI-Upgrade `init.tools` auf `TodoWrite`/`TaskCreate` prüfen und das Flag ggf.
  wieder aufnehmen (`docs/sdk-upgrade.md`). Die Tätigkeit aus `task_progress` wird nicht angezeigt (dafür
  bräuchte es ein Contract-Feld). Umsetzung und Tests: `backend/sdkOptions.ts`, `backend/sdkBackend.ts`,
  `sessions/normalizer/live.ts`, `backend/fake/{dsl,phase3}.ts` und die zugehörigen Tests „WP61-0x: …“.

## Vorschläge für die READMEs (Koordinator)

**`src/server/sessions/README.md`**
- Tabelle Phase 3, Zeile `freshContext.ts`, Inhalt: „… Prüfungen; Retry-Abbruch erst nach Annahme im Lock
  (CR3-08), deny + interrupt, höchstens `freshContextResultMs` auf das `result` des Planungs-Turns warten
  (WP61-03), Unterhaltung endet mit `fresh_session`, neue ohne Resume, erster Prompt `freshContextPrompt`
  (`summary.ts`, `@` neutralisiert, WP61-01) – ADR-155“.
- Tabelle Phase 3, neue Zeile `planIndex.ts` | `withPlanIndex`, `PlanIndexedDecisionStore` | „bekannte
  Planversionen je Serverlauf (gespeichert oder gelesen); `planStored` ohne erneutes Lesen, unbekannte einmal
  (CR3-09, ADR-155); der Manager umhüllt `stores.decisions`“.
- Zeile `summary.ts`, Exporte/Inhalt: „… Unterhaltungs-Helfer, `neutralizeAtMentions` (U+200B vor den `@`, die
  die CLI expandiert; WP61-01)“.
- Zeile `runtime.ts`, Exporte: `SessionRuntime` um `nextTurnResult` ergänzen (WP61-03).
- Zeile `entryState.ts`: `SessionManagerOptions` (u. a. `lifecycleShutdownWaitMs`, `freshContextResultMs`);
  `EngineCoreStores.decisions` ist ein `PlanIndexedDecisionStore`.
- Absatz „Außerdem“: „… `plan.list` über `planStored` des Plan-Index (CR3-09) …“.

**`src/server/sessions/lib/README.md`** – Zeile `timers.ts`, Exporte: „…, `settledWithin(timers, work, ms)`
(Promise gegen eine Obergrenze auf der Engine-Uhr; Shutdown, frischer Kontext)“.

**`src/server/sessions/normalizer/README.md`** – Zeile `live.ts`: „… Tasks (`task_progress.description` ist
die Tätigkeit, nie der Name; WP61-07) …“.

**`src/server/backend/README.md`**
- Zeile `sdkOptions.ts`, Inhalt: „… Flag-Settings (C.1: `autoCompactWindow`, Phase 2: `fastMode`; kein
  `todoFeatureEnabled`, WP61-02/ADR-156) inline, mit Settings-Datei erst nach der Bereitschaft; ohne Wert keine
  `settings`-Option“.
- Zeile `sdkBackend.ts`: `SdkBackendDeps` um `logger?` ergänzen; Inhalt: „… `debug`-Zeile
  `credentialExpiresAt` beim ersten `result` je Prozess (WP61-04)“.

**`src/server/backend/fake/README.md`** – Zeile `dsl.ts`: „`taskProgress` (mit `activity` → `description`
wie die CLI, WP61-07)“; Zeile `phase3.ts`: „`fake:background` sendet Tätigkeiten ‚Running …‘“.

**Außerhalb S, ebenfalls Koordinator:** `docs/wp/WP-52.md` Z. 52/142 (`todoFeatureEnabled` in
`startFlagSettings`) als überholt markieren (Verweis ADR-156).

## Vorschlag für `docs/sdk-upgrade.md` (Checkliste)

Neuer Punkt in §7 bzw. „Abschluss“ – „Nach WP-61 bei jedem CLI-Upgrade prüfen“:
- `init.tools` (auch deferred) auf `TodoWrite`/`TaskCreate`: tauchen sie auf, `todoFeatureEnabled` wieder
  erwägen (ADR-156) und die Aufgabenleiste live prüfen (B7/B25).
- `@`-Regel der CLI: Trenner vor `@` (2.1.322: `\s` und 。、？！; Anführungsform `@"…"`) mit
  `neutralizeAtMentions` (`sessions/summary.ts`) und der Nachbildung in `summary.test.ts` abgleichen; Live-Fall:
  Plan mit `@README.md` → „Mit frischem Kontext umsetzen“ → kein Datei-Attachment/Read im CLI-JSONL (B19).
- Frischer Kontext: kommt das `result` des abgewiesenen Planungs-Turns innerhalb von `freshContextResultMs`
  (Kosten der alten Unterhaltung > 0, keine Zeile „no result of the denied turn“)?
- Server-Log mit `--log-level=debug`: Zeile `first result: credential expiry` je Prozess (B15).

## Vorschlag für `docs/sdk-findings.md` (Nachtrag 12.11.2026, Punkt „`@` im SDK-Prompt“)

„Regel der CLI 2.1.322 (aus dem Binary): ohne Anführungszeichen ein Token aus `[^\s]+`, dessen `@` am
Tokenanfang oder direkt nach 。、？！ steht; mit Anführungszeichen `(^|[\s。、？！])@"([^"]+)"`. U+200B ist
kein `\s` – ein vorangestelltes U+200B verhindert die Expansion (WP61-01, ADR-155).“ Außerdem beim Punkt
„Plan-Modus“: „Seit CR3-S wartet die Engine nach `deny + interrupt` bis zu 3 s auf das `result`; live noch
nicht bestätigt.“

## Follow-ups

- **Live** bei der nächsten Abnahme: WP61-01 (B19 wiederholen) und WP61-03 (liefert die CLI nach
  `deny + interrupt` ein `result`? Sonst bleibt es beim Schließen nach 3 s ohne Kosten).
- Optional, Contract-Wunsch: `DecisionStore.hasPlan(entryId, version)` (nur `stat`) – dann liest auch das erste
  `plan.list` nach einem Neustart keine Plantexte mehr. Kein Muss: ohne ihn liest jeder Serverlauf jede Version
  höchstens einmal.
- Beobachtung, nicht geändert: `switchConversation` und `setArchived` rufen `cancelRetry` ebenfalls vor dem
  Lock. Beim Wechsel ist das gewollt (ein in der Wartezeit gefeuerter Retry würde sonst die Ziel-Unterhaltung
  starten); beim Archivieren wirkungslos, weil `startRuntime` archivierte Einträge ablehnt. Bei Bedarf eigener
  Fund.
- `e2e/phase3-tasks.spec.ts` hängt jetzt am Normalizer-Fix WP61-07 (Fake sendet „Running …“ als
  `description`): beim Merge-`pnpm e2e` mitprüfen.
- Die Tätigkeit aus `task_progress` könnte das Task-Panel als Aktivität zeigen – nur mit Contract-Feld.

## Checks

- `pnpm typecheck` (zweimal; der zweite Lauf nach allen Änderungen grün).
- ESLint auf allen geänderten und neuen Dateien: ok (`--max-warnings=0` sinngemäß, keine Meldung).
- Vitest gezielt: `src/server/sessions` + `src/server/backend` **1164 Tests in 56 Dateien grün**; nach dem
  letzten Feinschliff (Unicode-Escapes statt literaler Zeichen in `summary.ts` und
  `phase3.integration.test.ts`) die beiden Dateien erneut grün (85 Tests).
- Neue Regressionstests: 19 (Integration 5, `summary` 4, `planIndex` 4, `sdkBackend` 3, `timers` 2,
  `live` 1), dazu angepasste Erwartungen in `sdkOptions.test.ts`, `sdkBackend.test.ts`, `fake/dsl.test.ts` und
  im Integrationstest „open decision“. Rotlauf gegen den alten Code: siehe Tabelle (u. a. `sdkOptions` 26,
  `sdkBackend` 7, Integration 6 – darunter der später ersetzte erste CR3-08-Test –, `summary` 3, `live` 1, `dsl` 1); der CR3-08-Wächter und der Kontrolltest der
  CLI-Nachbildung sind alt wie neu grün (der Kontrolltest scheiterte im ersten Rotlauf nur an einem
  Escape-Fehler im Test selbst).
- Prettier: geänderte Dateien, die auf der Basis schon formatiert waren, sind formatiert; sieben Dateien waren
  schon auf der Basis nicht Prettier-konform (u. a. `phase3.integration.test.ts`, `normalizer/live.ts`) und
  wurden nicht umformatiert (kleiner Diff). Lint prüft Prettier nicht.
- Nicht gelaufen (Auftrag): `pnpm check`, `pnpm build`, `pnpm e2e`.
