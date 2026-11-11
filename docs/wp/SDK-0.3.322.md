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

_(füllt der Subagent: Versionen alt/neu, Peer-Ranges, Typ-Änderungen und Anpassungen, Snapshot-Diff
(Zusammenfassung), neue `unknownCounts`-Schlüssel, Validierungs-Drops, Live-Smoke, Kosten, Rückbau,
Neue SDK-Fähigkeiten, Wünsche an den Koordinator)_
