# FIX-41 – Fix-Runde nach der Live-Abnahme WP-41 (Phase 2)

> Koordinator, 18.10.2026. Grundlage: `docs/wp/WP-41.md` §2.3 (Befunde WP41-01 … WP41-08: 0 BLOCKER,
> 2 SOLLTE, 6 NIT). Entscheidung zu WP41-08: ADR-128. WP41-03 (Prompt-Vorschläge ohne Ghost-Text) ist kein
> nachweisbarer Parallax-Fehler und geht als Nachtrag in `docs/sdk-findings.md` (Koordinator).

## 1. Ablauf

- Zwei Pakete parallel, je eigener Worktree `.worktrees/fix-41-fN`, Branch `fix/41-fN`, Basis `main`:
  **F1 Server** und **F2 Web**. Danach Merge (Koordinator, `--no-ff --no-commit`, `pnpm check` +
  `pnpm build`), dann voller E2E-Lauf (FakeBackend) durch den Koordinator.
- Jeder Befund wird behoben **mit Test** (Gegenprobe: ohne Fix rot, wo sinnvoll) oder begründet
  zurückgestellt (im Ergebnis unter „Zurückgestellt“ mit Grund).
- Nur die Pfade des eigenen Pakets ändern (Tabelle §2). Contracts/Ports/`src/shared/**`/`package.json`/
  Lockfile: tabu (Wunsch → Bericht).
- **Kein Live-`claude`, keine Desktop-Bedienung** (keine Klicks/Tastatur/Fenster-Fokus/Bildschirmfotos/
  UI Automation per Skript, Nutzer-Regel 18.10.2026). UI-Prüfung nur über Vitest/happy-dom und, falls
  nötig, `pnpm e2e` (headless Edge, FakeBackend).
- Ergebnis je Paket in `docs/wp/FIX-41-F1.md` bzw. `FIX-41-F2.md`; Live-Nachprüfung der Fixes in der
  Nutzer-Checkliste von WP-41 §2.6.

## 2. Pakete

| Paket | Pfade (exklusiv in dieser Runde) | Befunde |
|---|---|---|
| **F1 Server** | `src/server/**` ohne `ports.ts`/`backend/{types,fixture}.ts` | **WP41-04** (Debug-Log je Benachrichtigung: Ziel-Client, Kanal, Grund), **WP41-08** (ADR-128: Tool-Shell-Variablen der aufrufenden Claude-Session auch für SDK-Spawns entfernen) |
| **F2 Web** | `src/web/notifications/**`, `src/web/lib/path-display.ts` (+ Test), `src/web/shell/{SessionHeader.tsx,navigation/**}`, `src/web/features/{profiles,composer}/**` | **WP41-01** (Töne ohne Geste, wenn der Browser Audio erlaubt – ADR-120 wirksam machen), **WP41-02** (Pfad-Ende sichtbar in Sidebar und Kopfzeile), **WP41-05** (Abo-Limits je Konto statt je Profil), **WP41-06** (Hinweis: „Profil testen“ kann `.claude.json` im `configDir` anlegen), **WP41-07** (kein Prompt im Moment des Handoffs; wiederhergestellter Entwurf mit Cursor am Ende) |

## 3. Ergebnisse

Je Paket eine eigene Datei `docs/wp/FIX-41-F1.md` bzw. `FIX-41-F2.md` (dieses Dokument bleibt
unverändert): je Befund „behoben“ (Fix + Test, Gegenprobe) oder „zurückgestellt“ (Grund),
Entscheidungen, Checks, Live-Prüfpunkte, Wünsche an den Koordinator.
