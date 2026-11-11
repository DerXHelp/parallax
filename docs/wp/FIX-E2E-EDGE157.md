# FIX-E2E-EDGE157 – zwei E2E-Fälle rot seit dem Edge-Update 155 → 157

> Koordinator, 11.11.2026. Worktree `.worktrees/fix-e2e-edge157`, Branch `fix/e2e-edge157`, Basis `main`
> = `53d23c6` (Merge `feature/question-tabs`). Fehler der produktiven Basis → `fix/<name>` von `main`
> (CLAUDE.md „Git“), Merge nach `main` durch den Koordinator.

## 1. Befund (Koordinator)

`pnpm e2e` auf `main` (`53d23c6`): 43/45 grün, 2 rot. Gezielte Wiederholung
(`--repeat-each=3`): 4 von 6 rot. **Derselbe Stand vor dem Merge (`73381c6`) ist ebenso rot (5 von 6)** –
der Merge der Frage-Tabs ist nicht die Ursache. Letzter grüner Volllauf: 19.10.2026 (45/45). Seitdem hat
sich Edge selbst aktualisiert: **155.0.4283.62 (WP-41) → 157.0.4341.46 (jetzt)**. Die Läufe liefen
sequenziell und ohne Fremdlast.

| Fall | Fehler |
|---|---|
| `e2e/phase2-lifecycle.spec.ts:34` „earlier conversation: after /clear …“ | Klick auf das Kopfzeilen-Menü „…“ (`[data-slot="session-menu"]`, `support/app.ts:197`) öffnet kein `role="menu"` (Timeout 15 s). Screenshot: der Knopf hat den Fokusrahmen, das Menü bleibt zu. Teils auch `locator.click` auf `[data-action="conversations"]` im Timeout. |
| `e2e/phase2-navigation.spec.ts:157` „focus comes back after Esc …“ | `Escape` schließt den Dialog „Neue Session“ (`[data-slot="new-session-dialog"]`) nicht (`toBeHidden`, Zeile 209). |

Artefakte (Screenshots, Traces, Server-Logs, WS-Frames, Logs der drei Läufe):
`C:\Users\XHelp\AppData\Local\Temp\claude\d9d013913ce447a5\c0a8ce4a-0208-43dc-a63d-f34e46e01510\scratchpad\e2e-edge157\`
(`main-e2e.log`, `rerun.log`, `rerun-old.log`, Ordner je Fall mit `trace.zip`).

Beobachtung: Andere Fälle mit Radix-Menüs/Dialogen (z. B. `phase2-navigation.spec.ts:91` Kontextmenü,
Umbenennen) liefen grün – das Fehlerbild ist nicht durchgängig, aber gut reproduzierbar.

## 2. Auftrag

1. **Ursache klären** (Traces, gezielte Wiederholungen, ggf. Diagnose-Ausgaben im Test, die danach wieder
   entfernt werden). Kernfrage: **Betrifft das die App im echten Edge 157** (z. B. Radix-`DropdownMenu`
   öffnet auf `pointerdown`, Esc-Handling bei Fokus in einem bestimmten Element, Timing nach Render/Fokus-
   Wechsel) **oder nur die Automatisierung** (Playwright-Klick/Tastatur gegen Edge 157, Test-Annahmen)?
2. **An der Ursache beheben:**
   - App-Fehler → Fix in der App mit Unit-Test (happy-dom), wo sinnvoll, plus grüner E2E-Fall.
   - Test-Fehler → Test bzw. `e2e/support` robust machen: auf Zustände/Ereignisse warten statt feste
     Wartezeiten; **keine Retries**, keine abgeschwächten Prüfungen, kein `force: true` als Ausweg.
3. Prüfen, ob dieselbe Ursache weitere Stellen trifft (andere Menüs/Dialoge, `support/app.ts`-Helfer) und
   diese mit beheben.

**Besitz-Pfade:** `e2e/**` (ohne `e2e/live/**`), diese Datei. Falls die Ursache in der App liegt:
minimal und begründet in `src/web/shell/**`, `src/web/ui/**`, `src/web/features/**` (im Ergebnis
auflisten). **Tabu:** `src/shared/**`, `src/server/**`, `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, Root-Configs (Wunsch → Bericht). Parallel läuft das SDK-Upgrade
(`.worktrees/sdk-0.3.322`) – dort nichts anfassen; es kann Last erzeugen (ebenfalls Playwright/Edge),
Ergebnisse unter Last im Ergebnis kennzeichnen.

**Regeln:** Kein Live-`claude` (nur FakeBackend). **Keine Desktop-Bedienung** per Skript (keine Klicks,
Tastatur, Fenster-Fokus, Bildschirmfotos, UI Automation außerhalb von Playwright; Nutzer-Regel
18.10.2026). Lange Läufe (`pnpm check`, `pnpm e2e`) im Hintergrund mit Ausgabe in Dateien. Gestartete
Prozesse am Ende beenden. Nie `%LOCALAPPDATA%\Parallax` anfassen.

## 3. Abnahme

- Beide Fälle: `pnpm exec playwright test e2e/phase2-lifecycle.spec.ts:34 e2e/phase2-navigation.spec.ts:157 --repeat-each=10` grün.
- `pnpm e2e` zweimal vollständig grün (45/45).
- `pnpm check` und `pnpm build` grün.
- Edge-Version im Ergebnis nennen (`(Get-Item 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe').VersionInfo.ProductVersion`).

**Commit:** lokal auf `fix/e2e-edge157` (Deutsch, mehrere `-m`, kein Heredoc), nicht pushen, nicht mergen.
Bericht im Format aus `CLAUDE.md`.

## 4. Ergebnis

_(füllt der Subagent: Ursache, betroffen App/Test, Fix, Gegenprobe, Läufe mit Zahlen, Edge-Version,
weitere betroffene Stellen, Wünsche an den Koordinator)_
