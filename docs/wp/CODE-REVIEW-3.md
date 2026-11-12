# Abschließendes `/code-review` Phase 3 und Fix-Runde mit den WP-61-Befunden

- **Datum:** 12.11.2026
- **Umfang:** `main...feature/phase-3` (Stand `c2a3e6c`, 457 Dateien, +44 893/−2 077 Zeilen) – ganz
  Phase 3 (WP-50 … WP-61, R5/R5-web/V4, FIX-R5 K/F1–F6).
- **Stufe:** high. Gründlich gelesen: Zugriffsprüfung (`resolveAllowedPath`), Route `/api/file` samt
  Origin-Guard, `spawnGui`/`spawnExplorer`, Anhang-Store, frischer Kontext. Dort kein Bruch gefunden.
  Web nur die riskanteren Module (Composer, Viewer-Zustand, Plan-Panel, Tasks, Seitenpanel, Kopfzeile).
- Die Funde sind **unverifiziert** (das Review hat nichts ausgeführt); jede Umsetzung beginnt mit einer
  Reproduktion per Test.
- Last während des Reviews: CPU im Mittel 6 %, höchstens 12 % (ADR-154).

## Funde (nach Schwere)

| Nr. | Datei:Zeile | Befund | Szenario (Kurzform) |
|---|---|---|---|
| CR3-01 | `src/web/shell/session-drop.tsx:78` | Die Drop-Zone der Pane gibt die rohen `dataTransfer.files` (Ordner als `File`) als `{files, folders: 0}` an den Composer; die Ordnerprüfung per `webkitGetAsEntry` aus `transferFiles` des Composers fehlt. | Ordner auf Transkript/Kopfzeile ziehen → Chrome liefert den Ordner als `File` (Typ '', 0 Byte) → `addAttachmentFiles` legt einen „file“-Chip an und lädt ihn als octet-stream hoch → 415 bzw. `CONNECTION_LOST` statt des Hinweises „Ordner werden nicht angehängt“. Die Ordnerprüfung muss nach `src/web/lib` (die Shell importiert keine Features). |
| CR3-02 | `src/web/shell/header-panels.tsx:41` | Der Zähler „N laufen“ am Tasks-Knopf nimmt `detail.backgroundTasks.length` inklusive Ambient-Tasks; das Task-Panel (`buildTaskRows`) und die Server-Fakten (`backgroundTasks` = nicht ambient) lassen sie weg. | Session mit nur einem Ambient-Task → Kopfzeile zeigt hervorgehoben „1“, das Panel keinen laufenden Task; solange er lebt, verdeckt der Zähler auch die offenen Todos. |
| CR3-03 | `src/server/http/app.ts:150` | `uploadKind` macht aus einem `application/octet-stream`-Upload, dessen Bytes als PNG/JPEG/GIF/WebP erkannt werden, ein Bild mit 3,75-MB-Grenze – ohne Skalierung im Client und nie als normale Datei gespeichert. | 5-MB-PNG ohne/mit falscher Endung (Browser-Typ '') → Client: „file“, roh als octet-stream → Server erkennt PNG, `LIMITS.imageBytes` → `PAYLOAD_TOO_LARGE`, obwohl Dateien bis 10 MB erlaubt sind; kleineres PNG mit 9000 px geht unskaliert als Bild-Block durch, die API lehnt ab, der Turn scheitert. |
| CR3-04 | `src/server/files/stat.ts:90` | `truncated` vergleicht nur die Quell-Bytes mit `fileTextBytes`; `readTextContent` kürzt aber auch, wenn die UTF-8-Form einer UTF-16- oder windows-1252-Datei länger ist. | 1,8-MB-Log in windows-1252 mit vielen Umlauten wird als UTF-8 > 2 MiB → `file.stat` meldet `truncated: false`, `/api/file` kürzt, der Viewer zeigt eine unvollständige Datei ohne Hinweis „gekürzt“. |
| CR3-05 | `src/server/http/app.ts:346` | `Content-Length` stammt aus der `stat`-Größe, Bilder/PDFs werden danach gestreamt; schrumpft die Datei dazwischen, kommen weniger Bytes als angekündigt. | Claude ersetzt ein PNG durch ein kleineres, während der Viewer pollt → `stat` 400 kB, Stream 250 kB → Antwort bricht mit Längenfehler ab, Bild lädt bis zur nächsten Änderung nicht. |
| CR3-06 | `src/web/features/files/state/stat-cache.ts:112` | `invalidate` tut während eines laufenden Ladens nichts, `useFileStat` merkt den Schreibzeitpunkt trotzdem als erledigt; ein Write, der während eines Stat-Requests endet, macht die alte Antwort nie ungültig. | `FileLink` mit `verify` auf eine noch fehlende Datei → `file.statMany` läuft, Write endet → `invalidateBefore` übersprungen, `handled.current = written`; Antwort `FILE_NOT_FOUND` mit `at = now()` > `written` → 30 s TTL lang „fehlt“, obwohl die Datei existiert. |
| CR3-07 | `src/web/features/tasks/lib/rows.ts:17` | Der Client zählt Tool-Calls mit Status `pending` als lebend (laufend, stoppbar); `hasStoppableTask` des Servers akzeptiert nur `running`/`background`. | Task-Zeile mit `pending`-Tool-Call zeigt „Stop“ → `session.stopTask` → `TASK_NOT_FOUND`, `stopTask` schluckt den Code still; Klick wirkungslos, Task läuft weiter. |
| CR3-08 | `src/server/sessions/freshContext.ts:47` | `approveFreshContext` ruft `s.cancelRetry()` vor dem Lock und vor `assertWithoutOtherWork`; ein danach mit `SESSION_BUSY` oder Gate-Fehler abgewiesener Request hat den geplanten Retry schon abgebrochen. | Abgelaufene Plan-Karte, geplanter Retry, eingereihter Prompt → „Mit frischem Kontext umsetzen“: Retry abgebrochen, dann `SESSION_BUSY` → nichts startet, der Retry kommt nie. Der alte Freigabe-Pfad bricht erst nach Annahme durch den Broker ab. |
| CR3-09 | `src/server/sessions/commands.ts:381` | `plan.list` liest bei jeder Anfrage den vollen Text jeder `plans/v<N>.md` (`readPlan`), nur um zu erfahren, ob sie existiert. | 30 Planversionen à 50 kB → jedes `plan.list` (bei jeder neuen Version/geschlossenen Entscheidung) liest ≈ 1,5 MB nur für ein Boolean; `stat` genügt. |
| CR3-10 | `src/server/files/sessionIndex.ts:293` | Der Index-Backfill (`readConversation`) lädt alle Seiten einer Unterhaltung in den Speicher und flacht sie ab, für alle Unterhaltungen eines Eintrags, ausgelöst durch die erste Datei-Op oder Pfadprüfung. | Nach dem Upgrade melden viele Sessions mit langem Verlauf kurz nach dem Start ihr erstes Read/Write → jede baut gleichzeitig ein Array des ganzen Transkripts → Speicherspitze im Server. Seitenweise verarbeiten. |

## Befunde aus WP-61 (live, Details `docs/wp/WP-61.md` §2.5)

| Nr. | Schwere | Befund (Kurzform) | Vorgabe des Koordinators |
|---|---|---|---|
| WP61-01 | SOLLTE | `@…` im übernommenen Plantext wird beim Umsetzen mit frischem Kontext von der CLI expandiert (Datei-Attachment + Read), auch ohne `client_composed`. | `@` im Plantext so neutralisieren, dass die CLI nichts expandiert, Claude den Pfad aber lesen kann (Mittel wie R5W-03/U+200B, oder Backticks – Wahl begründen); Unit-Test für die Umwandlung, Fake-Szenario falls möglich. |
| WP61-02 | SOLLTE | `todoFeatureEnabled` wirkt mit CLI 2.1.322 nicht (`TodoWrite`/`TaskCreate` fehlen in `init.tools`). | Laut B7: Flag aus den Flag-Settings nehmen (keine wirkungslose Einstellung senden); die Aufgabenleiste bleibt für `todos` aus dem Stream bereit. Vermerk in `docs/sdk-upgrade.md`-Prüfliste als Vorschlag im Ergebnis (Koordinator-Datei). |
| WP61-03 | NIT | Kosten/Usage des Planungs-Turns fehlen beim frischen Kontext (Prozess ohne `result` geschlossen). | Wenn ohne Contract-Änderung möglich: vor dem Schließen kurz auf `result` warten (mit Obergrenze) oder Usage des letzten `assistant` übernehmen; sonst begründet zurückstellen. |
| WP61-04 | NIT | `credential_expires_at` wird nirgends geloggt (B15). | Eine `debug`-Zeile beim ersten `result` je Prozess mit dem Feld (ohne weitere Auth-Daten). |
| WP61-05 | NIT | Dialog „Earlier conversations“ spricht von „before /clear“, auch bei frischem Kontext. | Text neutral fassen (en/de). |
| WP61-06 | NIT | Vordergrund-Shell eines Subagenten (`local_bash`, `isBackgrounded:false`) erscheint als eigener laufender Task; Kopfzeile 1, Panel 2. | Solche Shells dem Agenten unterordnen oder ausblenden; Zählung von Kopfzeile und Panel aus **einer** Funktion (zusammen mit CR3-02). |
| WP61-07 | NIT | `task_progress.description` (aktuelle Tätigkeit „Running …“) überschreibt den Task-Namen. | `description` aus `task_progress` nicht als Name übernehmen; höchstens als Aktivität, wenn das Feld dafür schon existiert (keine Contract-Änderung). |
| B18 | Entscheidung | Nur Hintergrund-Agent, kein Turn: CLI beantwortet „Queue“ und „Send now“ sofort; Composer-Stop wirkt nicht (WP-61 §2.3). | **Entscheidung Koordinator:** Solange kein Turn läuft, zeigt der Composer ein normales „Senden“ (keine Einreihen/Jetzt-senden-Wahl) und **keinen** Stop; gestoppt wird über das Task-Panel. Falls der Client „Turn läuft“ nicht von „nur Hintergrund“ unterscheiden kann, ohne Contract-Änderung: BLOCKED melden. |

## Fix-Runde (Plan, Koordinator 12.11.2026)

- Drei Pakete parallel, je eigener Worktree `.worktrees/cr3-<x>`, Branch `fix/cr3-<x>`, Basis
  `feature/phase-3` @ Stand dieses Dokuments. Danach Merge durch den Koordinator nacheinander
  (`--no-ff --no-commit`, `pnpm check` + `pnpm build`), am Ende ein voller `pnpm e2e`.
- **Ressourcen (ADR-154, verbindlich):** Die Pakete starten **keine** schweren Läufe – kein `pnpm check`,
  `pnpm test`, voller `vitest run`, `pnpm build`, `pnpm e2e`, `pnpm install`. Erlaubt:
  `pnpm exec vitest run <eigene pfade> --maxWorkers=2`, `pnpm exec eslint <eigene pfade>`,
  `pnpm typecheck` (ein Prozess, höchstens zweimal je Paket). Volle Checks macht der Koordinator.
- Vorgehen je Fund: **erst ein Test gegen den alten Code (rot), dann der Fix (grün)**; die Tests
  bleiben als Regression. Nicht reproduzierbar oder kein Fehler → begründet zurückgestellt.
- Contracts/Ports/`src/shared/**`/`package.json`/Lockfile: tabu. Fehlercodes nur bestehende.
- Kein Live-`claude`, keine Desktop-Bedienung (Nutzerregel 18.10.2026).

| Paket | Pfade (exklusiv in dieser Runde) | Funde | ADR-Nummern (Vorschläge) |
|---|---|---|---|
| **S Engine/Backend** | `src/server/sessions/**`, `src/server/backend/**` (je ohne `ports.ts`, `types.ts`, `fixture.ts`, `README.md`) | CR3-08, CR3-09, WP61-01, WP61-02, WP61-03, WP61-04, WP61-07 | ADR-155, ADR-156 |
| **D Datei-Dienst/HTTP** | `src/server/files/**`, `src/server/http/**` (je ohne `ports.ts`, `README.md`) | CR3-03, CR3-04, CR3-05, CR3-10 | ADR-157 |
| **W Web** | `src/web/shell/**`, `src/web/features/{files,tasks,composer}/**`, `src/web/lib/**` (neue Datei für die Ordnerprüfung + Test), `src/web/state/**` (nur falls für B18/Zählung nötig) – je ohne `README.md` mit mehreren Ownern | CR3-01, CR3-02, CR3-06, CR3-07, WP61-05, WP61-06, B18 | ADR-158, ADR-159 |

Ergebnis je Paket in `docs/wp/CODE-REVIEW-3-S.md`, `-D.md`, `-W.md` (Tabelle je Fund: reproduziert,
Fix, Regressionstest, Commit). ADR-Texte und README-Änderungen schreiben die Pakete als Vorschlag in
ihr Ergebnis; `docs/decisions.md` und die Ordner-READMEs mit mehreren Ownern pflegt der Koordinator
beim Merge.

## Umsetzung

Fix-Runde 12.11.2026, drei Pakete parallel ohne schwere Läufe (CPU über die ganze Runde im Mittel 13 %,
höchstens 74 %); Details je Fund in `docs/wp/CODE-REVIEW-3-S.md`, `-D.md`, `-W.md`. ADR-155 … ADR-159
(`docs/decisions.md`, in Merge-Reihenfolge angehängt: 157, 158, 159, 155, 156).

| Nr. | Reproduziert | Fix (Kurzform) | Merge |
|---|---|---|---|
| CR3-01 | ja | Ordnerprüfung als `@web/lib/transfer-files`, genutzt von Composer und Pane-Drop; Anfrage `attachFiles` mit `folders?` | `9c5a75c` |
| CR3-02 | ja | eine Zählung für Kopfzeile und Task-Panel (`@web/lib/task-rows`, ohne Ambient), ADR-158 | `9c5a75c` |
| CR3-03 | ja | octet-stream bleibt Datei, auch mit Bild-Bytes; Bild nur bei deklariertem Bildtyp, ADR-157 | `f3290f6` |
| CR3-04 | ja | `truncated` exakt (Lesen nur, wenn Größe/Kodierung es offen lassen; LRU je Dateiversion), ADR-157 | `f3290f6` |
| CR3-05 | ja | Bilder/PDFs über ein Handle ganz gelesen, `Content-Length` = gesendete Bytes, ADR-157 | `f3290f6` |
| CR3-06 | ja | Stat-Cache verwirft Antworten über einen während des Requests beendeten Write | `9c5a75c` |
| CR3-07 | ja | `pending` nicht laufend/stoppbar – im Task-Panel und (Nachtrag) in der Agent-Karte | `9c5a75c` |
| CR3-08 | nur White-Box (Retry-Verlust nicht erreichbar, Begründung in `-S.md`) | `cancelRetry` erst im Lock nach Annahme, ADR-155 | `8cd41c0` |
| CR3-09 | ja | Plan-Index je Serverlauf (`withPlanIndex`), jede Version höchstens einmal gelesen, ADR-155 | `8cd41c0` |
| CR3-10 | ja | Backfill seitenweise rückwärts, höchstens eine Seite im Speicher, ADR-157 | `f3290f6` |
| WP61-01 | ja | U+200B vor den `@`, die die CLI expandieren würde (`neutralizeAtMentions`), ADR-155 | `8cd41c0` |
| WP61-02 | ja | `todoFeatureEnabled` entfernt, ADR-156; Prüfpunkt in `docs/sdk-upgrade.md` | `8cd41c0` |
| WP61-03 | ja | nach deny + interrupt höchstens 3 s auf das `result` warten (live zu bestätigen), ADR-155 | `8cd41c0` |
| WP61-04 | ja | `debug`-Zeile `credentialExpiresAt` beim ersten `result` je Prozess, ADR-156 | `8cd41c0` |
| WP61-05 | ja | Dialogtext „Frühere Unterhaltungen“ neutral (en/de) | `9c5a75c` |
| WP61-06 | ja | Vordergrund-Shells von Subagenten ausgeblendet, Zählung angeglichen, ADR-158 | `9c5a75c` |
| WP61-07 | ja | `task_progress.description` nie als Task-Name; Fake sendet „Running …“ wie die CLI, ADR-156 | `8cd41c0` |
| B18 | – | ohne laufenden Turn normales „Senden“, kein Stop (aus `turn_result`-Reihenfolge abgeleitet), ADR-159 | `9c5a75c` |

**Checks nach dem letzten Merge (`8cd41c0`):** `pnpm check` grün (4934 Tests, 290 Dateien), `pnpm build`
grün, Bundle-Budget ok (Start +3.464 B raw gegen `109c073`), `pnpm e2e` 65/65 grün (zwei Läufe: 5,3 und
4,5 min).

**Beobachtung E2E-Dauer:** Seit dem Nachmittag dauert `pnpm e2e` 4,5–6,2 statt 3,0 min (F6, 14:56);
einzelne Tests mit mehreren Fenstern/Sessions brauchen +10 … +38 s (`windows.spec.ts:11` 10 → 41–48 s).
Gegenproben: die Basis vor der Fix-Runde (`8b54b9c`) ist genauso langsam (5,4 min), ebenso ein frischer
Worktree (6,2 min); einzeln laufen die Specs normal schnell; CPU im Mittel 16–19 %, keine übrig
gebliebenen Prozesse, `claude --version` 26–80 ms. **Keine Regression der Fix-Runde**; Ursache in der
Umgebung, nicht gefunden (Kandidaten: Sicherheitssoftware/Web-Traffic-Scan, Plattenlast, parallele Arbeit
am Rechner). Bei Wiederauftreten mit `--log-level=debug` und Playwright-Trace untersuchen.

**Offen für die nächste Live-Abnahme:** WP61-01 (B19 wiederholen), WP61-03 (`result` nach dem Interrupt?),
Nutzer-Checkliste WP-61 §2.7 inkl. N18 (Ordner per Explorer auf die Pane).
