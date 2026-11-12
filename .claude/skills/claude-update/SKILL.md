---
name: claude-update
description: Prüft ein neues `claude` (Claude Code CLI) gegen das in Parallax geprüfte CLI-Profil mit `pnpm cli-check` (live, Haiku, Abo, höchstens 0,05 USD), übernimmt das Profil bei grünem Ergebnis über `fix/cli-<version>` nach `main` und meldet Abweichungen. Verwenden, wenn Parallax „neuer als die geprüfte Version“ zeigt, `claude --version` vom Profil abweicht oder der Nutzer `/claude-update` aufruft.
---

# `/claude-update` – Kurz-Check nach einem `claude`-Update (Stufe 1)

Für den **Koordinator** im Parallax-Repo. Ziel: ein neues `claude` billig prüfen und Parallax aktuell
halten, ohne den großen SDK-Upgrade-Ablauf (Stufe 2, `docs/sdk-upgrade.md`). Hintergrund: WP-62,
`docs/sdk-upgrade.md` „Stufe 1: Kurz-Check“, Protokoll `docs/cli-updates.md`.

**Dauerfreigaben des Nutzers (12.11.2026, CLAUDE.md):**
1. `pnpm cli-check` darf ohne Rückfrage live laufen: Haiku, Abo-Login, kein API-Key, höchstens
   0,05 USD je Check.
2. Nach grünem Check darf der Koordinator nach `main` mergen und `main` pushen, wenn nur das CLI-Profil
   oder kleine Anpassungen betroffen sind. Größere Fixes vorher dem Nutzer zeigen.
3. `claude` aktualisiert sich weiter selbst.

**Immer:** Ressourcenregel ADR-154 (höchstens ein schwerer Lauf auf der Maschine; jeden PowerShell-Aufruf
mit `pnpm cli-check`/`check`/`build`/`e2e` mit `(Get-Process -Id $PID).PriorityClass = 'BelowNormal'; `
beginnen; lange Läufe im Hintergrund mit Ausgabe in eine Datei). Nie `%LOCALAPPDATA%\Parallax` anfassen.
Kein `record`, kein `dev:live`, kein anderer Live-Lauf. Commit-Regeln aus CLAUDE.md („Git“).

## 1. Version vergleichen (ohne Kosten)

```powershell
claude --version
(Get-Content src/server/claude/cli-profile.json -Raw | ConvertFrom-Json).cliVersion
```

- **Gleich:** fertig – dem Nutzer kurz „`claude` <v> ist bereits geprüft“ melden.
- **Installiert älter als das Profil:** nichts ändern, nur melden (z. B. Rückstufung).
- **Installiert neuer:** weiter mit Schritt 2.

Das Profil auf `main` zählt (`git show main:src/server/claude/cli-profile.json`), nicht das eines
Feature-Branches.

## 2. `pnpm cli-check` (live, allein, niedrige Priorität)

Worktree mit dem späteren Fix-Branch von `main` anlegen und den Check dort laufen lassen (dann reicht
für die Übernahme `--last`, ohne zweiten Live-Lauf):

```powershell
git worktree add .worktrees/cli-<version> -b fix/cli-<version> main
Set-Location .worktrees/cli-<version>
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'; pnpm install --frozen-lockfile
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'; pnpm cli-check *> <scratchpad>\cli-check.log
```

- Dauer etwa 2–4 Minuten (beim ersten Mal baut Playwright `dist/`). Vorher sicherstellen, dass kein
  anderer schwerer Lauf aktiv ist.
- Ablauf: Vorprüfung ohne Kosten → Probe (eine Haiku-Runde) → Live-Smoke `e2e/live` → Vergleich mit dem
  Profil → Bericht `test-results/cli-check/<zeitstempel>.md` → automatischer Rückbau eigener Daten.
- **Exit 0** = grün → Schritt 3. **Exit 1** = Abweichungen → Schritt 4.
- **Exit 2** = Abbruch. Bericht lesen („Stopped“):
  - `pre-check failed` (z. B. `ANTHROPIC_API_KEY` gesetzt, nicht per Abo angemeldet, `claude` zu alt
    für das SDK): nichts wiederholen, dem Nutzer melden.
  - `probe stopped (auth)` oder ein Billing-/Login-Fehler: **sofort stoppen, nicht wiederholen**, dem
    Nutzer melden.
  - sonst (z. B. Timeout): höchstens **einen** Wiederholungslauf; bleibt es bei Exit 2 → Nutzer.
- `pnpm e2e` (und jeder andere Playwright-Lauf) leert `test-results/` samt Bericht und `last-run.json`:
  Bericht vorher lesen bzw. nach `<scratchpad>` kopieren und `--last --accept` vor `pnpm e2e` ausführen.
- Der Abschnitt „Cleanup“ im Bericht listet Gelöschtes und „Left in place“ (Plan-Dateien,
  `~/.claude.json`-Einträge, nicht verifizierte Transkripte). Diese Punkte nur dem Nutzer nennen,
  nie selbst löschen.

## 3. Grün: Profil übernehmen und nach `main`

Im Worktree `fix/cli-<version>`:

```powershell
pnpm cli-check --last --accept          # ohne Live-Aufruf; schreibt Profil + Zeile in docs/cli-updates.md
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'; pnpm check
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'; pnpm build
git add src/server/claude/cli-profile.json docs/cli-updates.md
git commit -m "claude <version>: CLI-Profil übernommen (Kurz-Check grün)" -m "<Kosten, Ergebnis>" -m "<Attributionszeilen>"
```

- Bei zusätzlichen Code-Änderungen (Schritt 4, kleiner Fix) auch `pnpm e2e` (CLAUDE.md „Git“).
- Merge nach `main` mit `--no-ff` dort, wo `main` ausgecheckt ist oder werden kann (z. B. im
  Fix-Worktree nach dem Commit: `git switch main`, `git merge --no-ff fix/cli-<version>`), danach
  `git push origin main` (Dauerfreigabe 2).
- Danach `main` lokal in die laufenden Feature-Branches mergen (`git branch --list "feature/*"`, nur
  nicht gemergte). Konflikte → dem Nutzer zeigen. Push der Feature-Branches nur nach Freigabe (die
  Dauerfreigabe deckt nur `main`).
- Worktree und Branch aufräumen: `git worktree remove .worktrees/cli-<version>`,
  `git branch -d fix/cli-<version>`.

## 4. Abweichungen einordnen

Der Bericht nennt je Abweichung die betroffene Stelle („Affected“). „Notes“ (Slash-Commands, Agents,
Skills, Modell-ID, Versionen) zählen nicht.

**Klein** → im Worktree `fix/cli-<version>` beheben (mit Test), dann `pnpm cli-check --last --accept`
und weiter wie Schritt 3:
- neue Init-Schlüssel, `initializationResult`-Schlüssel oder Capabilities, die Parallax nicht braucht
  (das Parsen ist tolerant) – nur Profil übernehmen, ggf. Notiz in `docs/sdk-findings.md`;
- neue/entfallene Kontext-Kategorien oder Modelle – Profil, ggf. Fake-Antwort/`FAKE_MODELS`, Doku;
- `unknownCounts` > 0 für Nachrichten ohne sichtbare Bedeutung – tolerant ignorieren (Normalizer), Test;
- eine zuletzt eingeschaltete Option, die die neue CLI nicht mehr kennt – zurücknehmen.

**Größer** → dem Nutzer zeigen (Bericht, Einschätzung, Vorschlag), **nichts nach `main`**, Profil
nicht übernehmen (der Hinweis in Parallax bleibt dann sichtbar):
- Werkzeuge entfallen oder kommen hinzu, die Parallax nutzt (Kern-Werkzeuge, `TodoWrite`/`TaskCreate` →
  ADR-156 `todoFeatureEnabled`, Aufgabenleiste);
- `permissionMode`-Default geändert, Validierungs-Drops > 0, Fehler im Live-Smoke;
- alles, was eine neue Funktion, geändertes Verhalten/UX oder eine Contract-Änderung braucht.

Ein fehlgeschlagener Live-Smoke-Test darf einmal wiederholt werden (zählt als Live-Lauf, ≤ 0,05 USD);
scheitert er erneut → größer.

## 5. Stufe 2 vorschlagen

Dem Nutzer den großen Ablauf (`docs/sdk-upgrade.md`, SDK anheben, Fixtures neu aufzeichnen) vorschlagen,
wenn
- der Check echte Änderungen zeigt (Schritt 4 „größer“, neue Nachrichtentypen, neue Werkzeuge), oder
- das letzte SDK-Upgrade älter als etwa einen Monat ist (Kopfzeile „Stand“ in `docs/sdk-upgrade.md`,
  Zeile `SDK-…` in `docs/progress.md`), oder
- ein neueres `@anthropic-ai/claude-agent-sdk` passend zur neuen CLI erschienen ist
  (`claudeCodeVersion` im SDK-Manifest).

Stufe 2 läuft nie ohne Nutzer-Freigabe.

## 6. Kurzbericht an den Nutzer

Wenige Zeilen:
- `claude` alt → neu, Ergebnis (grün / N Abweichungen / Abbruch), Kosten (USD), Bericht-Pfad;
- was gemergt und gepusht wurde (Commit), oder was dem Nutzer zur Entscheidung vorliegt;
- ob die **produktive Instanz** ein `git pull` braucht: ja, wenn `main` sich geändert hat – nach dem
  Pull baut der Launcher beim nächsten Start neu, der Hinweis „neuer als geprüft“ verschwindet;
- Rückbau: „Left in place“-Punkte aus dem Bericht; ggf. Vorschlag Stufe 2.
