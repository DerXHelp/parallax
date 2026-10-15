# Flakes unter Parallel-Last – Protokoll und Fixes

> Querschnittsauftrag „Tests lastrobust“. Worktree `.worktrees/fix-flakes`, Branch `fix/flakes`,
> Basis `main` = `7380153`. Anlass: `pnpm check` wurde sporadisch rot, wenn mehrere Agenten
> gleichzeitig testeten, und war beim zweiten Lauf grün.

## Auftrag (sinngemäß)

- Flakes finden: mindestens 5× `pnpm exec vitest run`, davon mindestens 3× unter künstlicher Last;
  jeden roten Test protokollieren (Datei, Test, Fehlerart).
- Ursachen nur im Test bzw. in der Testinfrastruktur beheben: Wanduhr-Annahmen durch Fake-Timer
  ersetzen, echte Prozess-/Worker-/Netzwerk-Tests gezielt mit ausreichendem Timeout versehen und auf
  Ereignisse statt feste Wartezeiten warten. Kein Abschwächen von Produktivcode oder Prüfungen, keine
  Retries. Optional: moderat höheres Default-Timeout nur für das `node`-Projekt.
- Nachweis: danach erneut 5× (3× unter Last) grün, dann `pnpm check` grün.

**Besitz-Pfade:** alle `*.test.ts(x)` außer WP-13b (neue Dateien in `src/server/sessions/`) und
WP-21 (`src/launcher/**`), `test/setup/**`, `vitest.config.ts` (nur Timeouts), minimale begründete
Fixes in WP-10/11/12-Dateien, diese Datei.

---

## Methode

- Maschine: Windows 11, 12 logische CPUs, Node 26.4.0, Vitest 5.0.4 (Projekte `node` + `web`).
  Ein einzelner `vitest run` nutzt bereits alle Kerne (11 Worker).
- **Ohne Last:** ein `vitest run` allein.
- **Last L1:** drei `vitest run` gleichzeitig im selben Worktree (wie drei Agenten mit `pnpm check`);
  jeder der drei zählt als Lauf unter Last.
- **Last L2:** wie L1, zusätzlich ein CPU-Last-Skript mit 4 Dauerlast-Threads (Stresstest, deutlich
  über dem realen Fall: Laufzeit ≈ 3,3× des unbelasteten Laufs).
- Auswertung über `--reporter=json` (Fehlerart, Dauer je Test über alle Läufe). Last- und
  Auswerteskripte lagen im Scratch-Ordner (`%TEMP%\claude\parallax-flakes\`), nicht im Repo.

## Läufe vor den Fixes

| Lauf | Last | Dauer | Ergebnis |
|---|---|---|---|
| base1 | ohne | 138 s | grün (2152 Tests) |
| L1a / L1b / L1c | L1 | 303–307 s | rot: 7 / 5 / 6 Tests |
| L2a / L2b / L2c | L2 | 454–455 s | rot: 21 / 21 / 25 Tests (+ 1 Hook) |

Schon der unbelastete Lauf zeigte die Kandidaten: „already finished process“ 3,3 s (Limit 5 s),
QuestionCard/PermissionCard 5–6 s (Limit 20 s), viele Web-Tests 2–3 s ohne eigenes Limit.

## Gefundene Flakes

| Datei › Test | Läufe rot | Fehlerart | Ursache | Fix |
|---|---|---|---|---|
| `server/lib/process.test.ts` › killProcessTree „treats an already finished process as success“ | L1 3/3, L2 3/3 | Timeout 5 s | node-Start + taskkill-Start ≈ 3 s schon ohne Last | `SPAWN_TEST_TIMEOUT_MS` 30 s (+ node-Default 20 s) |
| `server/http/app.test.ts` › „answers /api/health …“ (erster Test) | L1 3/3, L2 3/3 | Timeout 5 s (7–13 s) | erster Server pro Worker: einmaliger Warm-up (~2 s ohne Last) | `beforeAll`-Warm-up (Server starten, `/api/health`, schließen; 60 s) |
| `server/sync/hub.integration.test.ts` › „exchanges a code … handshake“ (erster Test) | L1 3/3, L2 3/3 | Timeout 5 s (7–10 s) | dito | `beforeAll`-Warm-up (Server, Login, WS-Handshake; 60 s) |
| `web/App.test.tsx` › 2–7 Tests (Liste, Theme, Auswahl, Reconnect, Alt+1, neue Session …) | L1 3/3, L2 3/3 | Timeout 5 s | ganze Shell je Test, 1–3 s ohne Last, bis 11 s unter Last | Datei-Limit 30 s; Reconnect-`waitFor` 3 s → 15 s |
| `web/features/transcript/renderers/renderers.test.tsx` › Bash/PowerShell CRLF, Cap-Hinweis, Read/Grep/Glob | L1 3/3, L2 3/3 | Timeout 5 s | erster Einsatz lädt Lazy-Chunks (Highlighter, Grammatik) | Datei-Limit 30 s |
| `web/features/transcript/markdown/Markdown.test.tsx` › „renders GFM“ | L1 2/3 | `findByRole` nach 1 s nicht gefunden (Klartext-Fallback sichtbar) | erster Render suspendiert auf dem Lazy-Renderer; React holt ihn asynchron nach | `findBy*` mit `{ timeout: 15 s }` (`LAZY`) + globales `asyncUtilTimeout` |
| dito › `beforeAll` (Lazy-Imports) | L2 3/3 | Hook-Timeout 60 s | Import-Kette des Markdown-Renderers ≈ 17 s schon isoliert | Hook 180 s; Datei-Limit 60 s, Highlight-`waitFor` 30 s |
| `web/features/decisions/PermissionCard.test.tsx` › „a new decision ignores clicks during the arm delay“ | L2 1/3 | Assertion: Klick wurde angenommen | **Wanduhr-Annahme:** echte 150 ms Arm-Verzögerung; unter Last vergingen zwischen Mount und Klick mehr | Fake-Timer (`setTimeout`), Grenze 149/150 ms exakt geprüft, Klicks per `fireEvent` |
| dito › „marks project and user destinations …“ | L2 1/3 | `findByRole('menuitemradio')` nach 1 s nicht gefunden | Menü öffnet asynchron; 1 s RTL-Default zu knapp | globales `asyncUtilTimeout` 5 s |
| dito › „Always allow … four destinations“; `QuestionCard.test.tsx` › „sends the contract format …“ | L2 3/3 | Timeout 20 s | viele Tastenanschläge: 5–6 s im vollen Lauf, > 20 s unter L2 | Datei-Limit 60 s (auch Composer, pickers, PlanCard, DecisionBar) |
| `QuestionCard.test.tsx` › „Other in a single-select …“ | L2 2/3 | Assertion `otherText: "eYrAML"` bzw. Button „Answer“ fehlt | **Folgefehler:** der vorige, per Timeout abgebrochene Test tippte („prettier“) und klickte im Hintergrund weiter in den nächsten Test | entfällt mit ausreichendem Limit des Vorgängers |
| `web/shell/render-isolation.test.tsx` › 2–3 Tests | L2 3/3 | Timeout 5 s | ganze Shell, bis 14 s unter Last | Datei-Limit 30 s |
| `web/features/transcript/TranscriptView.test.tsx` › 3–4 Tests | L2 3/3 | Timeout 5 s | bis 10,5 s unter Last | Datei-Limit 30 s, `beforeAll` 180 s |
| `web/playground/playground.test.tsx` › „lists the demos …“ | L2 3/3 | Timeout 5 s | alle Demos, bis 11 s (nach den Fixes unter L2 bis 20 s) | Datei-Limit 60 s |
| `web/state/notices.test.tsx` › „SettingsMenu reports a failed settings.update“ | L2 2/3 | Timeout 5 s | Menü-Bedienung, bis 6,4 s | Datei-Limit 30 s |

## Vorbeugend gehärtet (unter Last knapp, aber noch nicht rot)

- `process.test.ts`: `runFile` „kills the whole process tree on timeout“ – das 1,5-s-Limit musste
  den Elternprozess starten **und** die Enkel-PID ausgeben lassen (unter L2 brauchte ein bloßer
  node-Start bis 2,4 s) → 6 s; der Timeout feuert weiterhin sicher (Elternprozess läuft endlos).
  PowerShell-Tests (`processInfo`/`childProcesses`): bis 47 s bei 60 s Limit, ein Aufruf bis ~23 s
  bei 20 s Produktiv-Default (ein Timeout hätte `null`/`[]` geliefert) → Aufrufe mit
  `timeoutMs: 60_000`, Tests 120 s. Liveness-Deadlines 10 s → 20 s (Polling mit Deadline, keine
  feste Wartezeit).
- `server/http/testServer.ts` (Testhilfe, WP-10): Deadlines von `TestWsClient.next()` und
  `rawUpgrade()` 3 s → 10 s. Sie greifen nur, wenn ein Ereignis ausbleibt (Test schlägt dann
  weiterhin fehl). Kein Test nutzte das Ablaufen als erwartetes Ergebnis.
- `app.test.ts` „rejected WebSocket upgrades“: Ersatz-Timer 3 s → 15 s (nur für einen Server, der
  nie schließt – dann rot wie bisher).
- `status-icon.test.tsx`: erster Test bis 3,2 s unter L2 → Datei-Limit 30 s.

## Entscheidungen

- **`node`-Projekt-Default** (`vitest.config.ts`, freigegeben): `testTimeout` 20 s, `hookTimeout`
  30 s. Begründung: dort laufen echte Prozesse (spawn, taskkill, PowerShell), echte Server/Sockets,
  `worker_threads` und Dateisystem; 5 s/10 s reichten unter Parallel-Last nicht. Langsame Fälle
  haben zusätzlich eigene, dokumentierte Limits.
- **`web`-Projekt ohne neuen Default** (nicht freigegeben): Limits je Datei per
  `vi.setConfig({ testTimeout })` – das vorhandene Muster der Feature-Tests – mit gemessenen Werten
  im Kommentar.
- **`asyncUtilTimeout` 5 s** (`test/setup/web.ts`): `findBy*`/`waitFor` warten auf Ereignisse; der
  RTL-Default 1 s ist eine versteckte Wanduhr-Annahme. Fehlende Elemente scheitern weiterhin, nur
  später. Kein Test erwartete das Ablaufen.
- **Warm-up statt größerem Einzel-Limit** für die ersten Server-Tests: die einmaligen Kosten liegen
  im `beforeAll` (eigenes Limit), jeder Test bleibt schnell und unabhängig von der Reihenfolge.
- Keine Retries, keine Änderung an Produktivcode. Geprüftes Verhalten (Timeouts von `runFile`,
  Arm-Verzögerung, Fehlerpfade) ist unverändert echt; die Arm-Grenze wird jetzt sogar exakt geprüft.
- Kein Flake (geprüft): `jsonStore` (Wartezeiten nur „mindestens“), `memoryStores` (≥ 15 ms bei
  20 ms Schlaf), `hub.integration` „expired code“ (1-ms-TTL) und Duplikat-Kommando (beide
  Reihenfolgen erfüllen die Prüfung), `hooks.test` (0-ms-Timer vor 5-ms-Wartezeit).

## Läufe nach den Fixes

| Lauf | Last | Dauer | Ergebnis |
|---|---|---|---|
| A2a / A2b / A2c | L2 (Stress) | 489–491 s | grün, je 2152/2152 |
| A1a / A1b / A1c | L1 | 274–275 s | grün, je 2152/2152 |
| A0a / A0b | ohne | 104–105 s | grün, je 2152/2152 |

Nach A2 wurde nur das Playground-Limit 30 s → 60 s angehoben (unter L2 bis 20 s gemessen); A1/A0
liefen mit dem Endstand. Größte Reserven-Verbraucher unter L2: `childProcesses` 46 s von 120 s,
QuestionCard „contract format“ 33 s von 60 s, PermissionCard „Always allow“ 23 s von 60 s.
Danach `pnpm check` grün.

## Follow-ups

- **Importkosten Web:** „import“ ist ~35 % der Testlaufzeit; die Import-Kette von
  `MarkdownRenderer` braucht isoliert ~17 s (react-markdown/remark-gfm ~5 s, lucide-react ~1 s,
  der Rest über `CopyButton`/`@web/ui`/`@web/state` – vermutlich das `radix-ui`-Sammelpaket).
  Vorbündeln (`deps.optimizer`) oder schmalere Importe würden die Last-Empfindlichkeit insgesamt
  senken – Root-Config, Sache des Koordinators.
- **Web-Default-Timeout:** ein moderater Default im `web`-Projekt (z. B. 20 s) wäre einfacher als
  Limits je Datei – braucht Freigabe.
- **WP-11 (Hinweis, nicht geändert):** `processInfo`/`childProcesses` haben 20 s Default; unter
  starker Last dauerte ein PowerShell/CIM-Aufruf bis ~23 s. Beim Server-Start (Orphan-Cleanup)
  würde ein Timeout als „kein Prozess“ gelesen. Ggf. Default erhöhen oder Timeout loggen.
