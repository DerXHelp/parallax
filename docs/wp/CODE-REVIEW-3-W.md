# Fix-Runde CR3 – Paket W (Web)

- **Datum:** 12.11.2026
- **Branch:** `fix/cr3-w` (Basis `feature/phase-3` @ `8b54b9c`), Worktree `.worktrees/cr3-w`
- **Auftrag:** `docs/wp/CODE-REVIEW-3.md` (Funde CR3-01, CR3-02, CR3-06, CR3-07; WP61-05, WP61-06; B18)
- **Ressourcen (ADR-154):** nur gezielte Läufe mit `BelowNormal`: `vitest run <eigene Pfade> --maxWorkers=2`,
  `eslint <Pfade>`, `prettier --check <Pfade>`, ein `pnpm typecheck`. Kein voller Check, kein Build, kein
  E2E, kein Dev-Server, kein Live-`claude`.

## 1. Ergebnis je Fund

Vorgehen je Fund: erst Test gegen den alten Code (rot), dann Fix (grün). „Rot“ ist die Ausgabe des
gezielten Vitest-Laufs vor dem Fix.

| Nr. | Reproduziert (Beleg) | Fix | Regressionstest | Commit |
|---|---|---|---|---|
| WP61-05 | ja – `expected 'Conversations of this session before …' not to match /\/clear/` | `navigation.conversations.description` neutral: en „Earlier conversations of this session. Opening one continues it here – the current one stays in this list.“, de „Frühere Unterhaltungen dieser Session. Öffnen setzt sie hier fort – die aktuelle bleibt in dieser Liste.“ | `shell/navigation/i18n/i18n.test.ts` („does not tie the list to /clear“) | `8662416` |
| CR3-06 | ja – Write endet während `file.statMany` läuft: Antwort `FILE_NOT_FOUND` kam mit `at: 1000020` statt veraltet an, das nächste `ensure` fragte nicht | `StatCache.invalidate` merkt einen **laufenden** Request (`staleOnArrival`), seine Antwort wird mit `at: 0` gespeichert (bleibt sichtbar, gilt aber als veraltet) → das `ensure` aus dem Effekt von `useFileStat` fragt sofort erneut. `invalidateBefore` greift auch bei `loading`. Ein noch im 50-ms-Batch wartender Pfad braucht keine Markierung (die Antwort entsteht nach dem Write) | `features/files/state/stat-cache.test.ts`: „a write that ends while the answer is on its way makes that answer stale“ (rot→grün), „a write before the batch is sent needs no second request“ (Schutz gegen unnötige Requests) | `ef08ffd` |
| CR3-01 | ja – Drop mit Ordner-Item: `expected [{…(2)}] to deeply equal [{…(3)}]` (Ordner als `File` in `files`, kein `folders`); Composer: `requestShell({files: [], folders: 2})` → `false` | `transferFiles` (Ordner per `webkitGetAsEntry`) aus `composer/lib/transfer.ts` nach **`src/web/lib/transfer-files.ts`** verschoben (gegreppt: kein anderer Helfer); die Drop-Zone der Pane (`shell/session-drop.tsx`) nutzt ihn und schickt `attachFiles {files, folders}`; der Composer zeigt bei `folders > 0` denselben Hinweis `composer.attachments.folders` und nimmt die Anfrage auch ohne Dateien an – kein Chip, kein Upload. Die Leseprobe (`composer/lib/folders.ts`) bleibt zweite Linie für Dateilisten ohne Einträge | `shell/session-drop.test.tsx` („a folder is known by its entry and left out“), `composer/attachments.test.tsx` („folders the drop zone already left out“), `lib/transfer-files.test.ts` (verschoben + 2 neue Fälle) | `2a36eef` |
| CR3-02 | ja – nur Ambient-Task: Kopfzeile „Tasks – 1 background task running“ statt „Tasks – 2 open to-dos“; laufender Tool-Call-Task ohne Listeneintrag: Kopfzeile ohne Zähler, Panel 1 | Zeilenmodell (`TaskRow`, `buildTaskRows`, `taskSourceItems`, `selectTaskSources`, neu `runningTaskCount`/`countRunningTasks`) aus `features/tasks/lib/rows.ts` nach **`src/web/lib/task-rows.ts`**; Kopfzeile (`selectSidePanelFacts.running`, mit Cache je Hintergrundliste + flach gleichen Task-Items) und Panel (`runningTaskCount(visible)`) zählen mit derselben Funktion. `features/tasks/lib/rows.ts` behält nur Panel-Helfer (`canStopTask`, `TASK_STOP_BASH`, `visibleTaskRows`, `finishedDuration`) | `shell/header-panels.test.tsx` („ambient tasks do not count“, „a running task the server does not list yet counts too“ – beide rot→grün), `lib/task-rows.test.ts` (Zählung, Cache) | `9a2f495` |
| CR3-07 | ja – `pending`-Tool-Call: `expected true to be false` (laufend, stoppbar) | `LIVE_TOOL_STATUSES` = `running`, `background` – genau `hasStoppableTask` des Servers; ein von der Hintergrundliste genannter Task bleibt laufend/stoppbar (der Server prüft die Liste zuerst) | `lib/task-rows.test.ts` („a pending tool call is not running“), `features/tasks/lib/rows.test.ts` („a pending tool call offers no Stop“) | `9a2f495` |
| WP61-06 | ja – Agent + Vordergrund-Shell des Subagenten: `expected ['agent:run','shell:run'] to deeply equal ['agent:run']` | Vordergrund-Shells **von Subagenten** (`parentToolUseId !== null`, `local_bash`, `isBackgrounded: false`) sind keine eigenen Zeilen (ausgeblendet) – außer eine Quelle meldet den Task als Hintergrund (`isBackgrounded` später `true` oder Eintrag in `backgroundTasks`). Die lange Vordergrund-Shell des Haupt-Agents bleibt (der Server kann sie stoppen) | `lib/task-rows.test.ts` („a subagent's foreground shell is part of the agent“), `shell/header-panels.test.tsx` („counts like the panel: a subagent's foreground shell …“) | `9a2f495` |
| B18 | ja – Composer nach beendetem Turn mit nur einem Hintergrund-Agenten: `expected 'queue' to be 'idle'` (Gegenprobe: alte Zeile `const working = isWorking(runState)` eingesetzt → rot, wiederhergestellt → grün) | **Nicht blockiert.** `composer/lib/turn.ts` leitet „Turn läuft“ aus vorhandenem Zustand ab: Status-Fakten (`runState: 'working'`, `backgroundTasks > 0`, `queuedPrompts === 0`, nicht `compacting`/`retrying`) **und** Transkript: der letzte Austausch des Haupt-Agents (Items mit `parentToolUseId === null`: Prompt, Antwort, Denken, Tool-Call, `task_notification`) ist ein `turn_result`; dazu `detail.queue` leer. Dann ist der Composer im Modus `idle`: normales „Senden“ (`priority: 'next'`), kein Stop, kein „Jetzt senden“, Esc stoppt nicht. Im Zweifel (kein `turn_result` geladen, etwas eingereiht) bleibt das alte Verhalten | `composer/Composer.test.tsx` („only background tasks, no turn (B18)“, inkl. Rückkehr in den Einreihen-Modus mit Stop nach neuem Prompt), `composer/lib/turn.test.ts` (4 Fälle) | `8316d96` |

Formatierungs-Nachtrag: `2e0a0c3` (Prettier, `TasksPanel.test.tsx`).

## 2. Entscheidungen und Abweichungen

1. **Anfrage `attachFiles` um `folders?: number` erweitert** (`src/web/shell/requests.ts`, in dieser
   Runde Pfad des Pakets W). Optional, damit bestehende Sender (z. B. `App.test.tsx`) unverändert
   bleiben. Der Hinweis bleibt an einer Stelle (Composer, Namensraum `composer`); die Shell braucht keinen
   eigenen Text. Nimmt kein Composer an (z. B. entfernter Host), erscheint wie bisher
   `navigation.drop.unavailable`.
2. **WP61-06: ausblenden statt einrücken**, und nur für Subagenten (Vorgabe des Koordinators). Einrücken
   bräuchte eine Eltern-Beziehung im Zeilenmodell und eine neue Darstellung in `TaskRowView`; die Arbeit
   der Shell steckt ohnehin im Agenten (Zusammenfassung, Ausgabedatei). Vordergrund-Shells des
   Haupt-Agents bleiben sichtbar und stoppbar.
3. **B18 ohne Contract-Änderung über `turn_result`-Items** statt über Zeitstempel (`lastTurn.endedAt`
   gegen `item.at`): Ein eingereihter Prompt trägt als `at` seine Sendezeit, liegt aber in der
   Reihenfolge hinter dem Turn-Ende – die Reihenfolge der Items ist eindeutig, Zeitstempel nicht.
   - Bekannte Lücke: Startet die CLI selbst einen Turn für eine Task-Meldung, die nur einen bestehenden
     Tool-Call aktualisiert (kein neues Item), zeigt der Composer bis zur ersten Ausgabe des Turns (≈ 1–3 s)
     „Senden“ ohne Stop. Ein dort gesendeter Prompt geht mit `priority: 'next'` und wird von der CLI
     eingereiht – nichts geht verloren. Eine robuste Lösung bräuchte ein Fakt „Turn läuft“ vom Server
     (s. 4).

### Verhaltensänderung der Kopfzeile (bewusst)
Der Zähler „N laufen“ zählt jetzt wie das Panel auch laufende Tool-Call-Tasks, die der Server (noch) nicht
in `backgroundTasks` führt (z. B. eine lange Vordergrund-Shell oder ein Vordergrund-Agent des
Haupt-Agents) und keine Ambient-Tasks mehr. Der Text bleibt „background task(s) running“ – passend zur
Panel-Überschrift „Hintergrund-Tasks“.

### Bundle
`src/web/lib/task-rows.ts` (bisher im Lazy-Chunk des Panels) liegt jetzt im Start-Chunk, weil die
Kopfzeile (Shell, eager) die Zählung braucht. Geschätzt ≈ 2 kB raw minifiziert; nicht gemessen (kein
Build erlaubt). Bitte beim Merge `scripts/bundle-budget.ts` prüfen (Reserve laut FIX-R5 ≈ 13,7 kB raw).
`transfer-files.ts` war schon statisch im Composer (Start-Chunk), daran ändert sich nichts.

## 3. Checks (gezielt, `BelowNormal`)

- `pnpm exec vitest run src/web/shell src/web/lib src/web/features/tasks src/web/features/composer --maxWorkers=2`:
  70 Dateien, 706 Tests grün.
- `pnpm exec vitest run src/web/features/files --maxWorkers=2`: 9 Dateien, 63 Tests grün.
- `pnpm typecheck` (einmal): grün.
- `eslint --max-warnings=0` und `prettier --check` über alle geänderten `.ts`/`.tsx`: grün.
- **Nicht ausgeführt** (macht der Koordinator): `pnpm check`, `pnpm build` + Bundle-Budget, `pnpm e2e`.

### E2E angepasst (nicht ausgeführt)
- `e2e/phase3-tasks.spec.ts`, Test „background agent …“: nach dem Start des Hintergrund-Agenten zusätzlich
  `data-mode="idle"` des Composers und kein `[data-action="stop"]` (B18). Der zweite Test („the composer's
  Stop ends the turn …“) bleibt unverändert gültig: der Turn von `fake:slow` erzeugt Items nach dem
  `turn_result` → Einreihen-Modus mit Stop.

## 4. Vorschläge für den Koordinator

### ADR-158 – Ein Task-Modell für Panel und Kopfzeile
- **Datum/WP:** 12.11.2026, CR3-W (CR3-02, CR3-07, WP61-06)
- **Entscheidung:** Das Zeilenmodell der Tasks (`buildTaskRows`, `TaskRow`, `runningTaskCount`,
  `countRunningTasks`, `selectTaskSources`) liegt in `src/web/lib/task-rows.ts`. Task-Panel und der Zähler
  des Knopfs „Aufgaben“ in der Kopfzeile zählen laufende Tasks nur über diese Funktion. Laufend (und damit
  stoppbar) ist nur, was `session.stopTask` des Servers annimmt: ein nicht-ambienter Eintrag der
  Hintergrundliste oder ein Tool-Call im Status `running`/`background` (`pending` nicht). Ambient-Tasks
  und Vordergrund-Shells von Subagenten (`local_bash`, `isBackgrounded: false`, `parentToolUseId` gesetzt)
  sind keine eigenen Zeilen, solange keine Quelle sie als Hintergrund meldet.
- **Begründung:** Die Shell importiert keine Features (ADR-126); zwei Zählungen liefen auseinander
  (Kopfzeile 1, Panel 2 – WP-61). Ein Stop-Knopf, den der Server mit `TASK_NOT_FOUND` beantwortet, ist
  wirkungslos (CR3-07).
- **Folgen:** Das Modul liegt im Start-Chunk (Budget prüfen). Die Kopfzeile zählt auch laufende
  Tool-Call-Tasks ohne Listeneintrag. Die Agent-Karte im Transkript prüft `pending` noch selbst
  (Follow-up).

### ADR-159 – Composer ohne Turn bei reinen Hintergrund-Tasks
- **Datum/WP:** 12.11.2026, CR3-W (B18, Entscheidung des Koordinators nach WP-61 §2.3)
- **Entscheidung:** Arbeitet die CLI (`runState: 'working'`) nur für Hintergrund-Tasks
  (`backgroundTasks > 0`, nichts eingereiht, kein Kompaktieren/Retry) und ist der letzte Austausch des
  Haupt-Agents im Transkript ein `turn_result` (Prompts, Antworten, Tool-Calls und `task_notification`
  zählen als Austausch; Subagent-Items nicht), zeigt der Composer den Ruhe-Modus: normales „Senden“
  (`priority: 'next'`), kein Stop, kein „Jetzt senden“, Esc stoppt nicht. Gestoppt wird im Task-Panel.
  Im Zweifel gilt der Einreihen-Modus wie bisher. Abgeleitet nur aus vorhandenen Contracts
  (`StatusFacts`, `TranscriptItem`, `detail.queue`) in `features/composer/lib/turn.ts`.
- **Begründung:** Ohne Turn beantwortet die CLI „Einreihen“ und „Jetzt senden“ gleich und sofort; ein
  Interrupt bewirkt nichts (WP-61 §2.3). Die Reihenfolge der Items ist eindeutig, Zeitstempel sind es
  nicht (eingereihte Prompts tragen ihre Sendezeit).
- **Folgen:** Lücke bei einem von der CLI selbst gestarteten Turn ohne neues Item bis zur ersten Ausgabe.
  Optionale spätere Contract-Erweiterung: Fakt „Turn läuft“ (z. B. `StatusFacts.turnActive` mit Default
  `false`, gesetzt vom Engine-Zustand zwischen Prompt-Start und `result`).

### README-Vorschläge (Ordner mit mehreren Ownern)
- `src/web/lib/README.md`, zwei neue Zeilen:
  - `transfer-files.ts` | Phase 3 (CR3-01, aus `features/composer/lib/transfer.ts`): `transferFiles(data)`
    – Dateien eines Drops/Einfügens, Ordner per `webkitGetAsEntry().isDirectory` gezählt und weggelassen
    (Chrome listet einen Ordner auch in `files`); synchron im Ereignis aufrufen. Genutzt vom Composer und
    von der Drop-Zone der Pane (`shell/session-drop.tsx`) |
  - `task-rows.ts` | Phase 3 (CR3-02, ADR-158, aus `features/tasks/lib/rows.ts`): Task-Zeilenmodell
    `buildTaskRows` (Hintergrundliste + Tool-Call-Tasks + `task_notification`, je `taskId` eine Zeile,
    „beendet“ gewinnt; ohne Ambient-Tasks und ohne Vordergrund-Shells von Subagenten), `runningTaskCount`/
    `countRunningTasks` (die eine Zählung für Panel und Kopfzeile; laufend nur `running`/`background`
    bzw. gelistet – wie `hasStoppableTask`), `selectTaskSources` (je Items-Array gecacht), `taskKind` |
- `src/web/shell/README.md`:
  - Zeile `header-panels.tsx`: „Zähler (laufende Hintergrund-Tasks hervorgehoben …)“ ersetzen durch
    „Zähler (laufende Tasks hervorgehoben – dieselbe Zählung wie das Task-Panel über
    `@web/lib/task-rows`, CR3-02 –, sonst offene To-dos)“.
  - Zeile `session-drop.tsx`: ergänzen „Ordner erkennt `transferFiles` (`@web/lib/transfer-files`) am
    Eintrag und schickt sie als Anzahl `folders` mit (CR3-01) – der Composer zeigt seinen Hinweis, auch
    wenn nur Ordner abgelegt wurden“.
  - Zeile `requests.ts`: `attachFiles` (`files`, `folders?` – CR3-01).

### Follow-ups
- **Agent-Karte im Transkript** (`features/transcript/items/AgentCard.tsx:128`, nicht Paket W): zählt
  `pending` wie CR3-07 als laufend und zeigt dann „Stop“ → `TASK_NOT_FOUND` still. Gleiche Korrektur
  (`running`/`background`) empfohlen.
- Vordergrund-Shells des Haupt-Agents erscheinen weiter als „Hintergrund-Task“ im Panel und zählen in der
  Kopfzeile; falls unerwünscht, in `task-rows.ts` die Bedingung `parentToolUseId !== null` streichen.
- Nutzer-Checkliste WP-61 N18 (echter Explorer-Ordner auf die Pane) nach dem Merge erneut prüfen.
