# FIX-R4 – Fix-Runde nach R4 und V3 (Phase 2)

> Koordinator, 18.10.2026. Grundlage: `docs/wp/R4.md` (Server), `docs/wp/R4-web.md` (Web),
> `docs/wp/V3.md` (Verifier). Entscheidungen: ADR-121 … ADR-126 (`docs/decisions.md`). Das
> Koordinator-Paket K ist auf `main` gemergt (siehe Contract-Changelog in `docs/progress.md`):
> `@shared/secrets` (`isSecretEnvKey`), `LIMITS.attachmentsTotalBytes`, `DEFAULT_PORT` in
> `@shared/model`, Slot-Prop `ProfilesSettingsSlotProps.onDirtyChange` (bereits von
> `ProfilesSettings` gemeldet), `ui/switch` (deaktiviert + an neutral), `ui/dialog`
> (`grid-cols-[minmax(0,1fr)]`, V3-01 Teil 1), unbenutzte Kern-Schlüssel entfernt, Regel ADR-126 in
> `CLAUDE.md`/architecture §2.3 (h)/(i), instabiler Test V3-08 (`ProfilesSettings.test.tsx` wartet auf
> die Prüfung des ganzen Werts).

## 1. Ablauf

- Welle Fa (parallel, je eigener Worktree `.worktrees/fix-fN`, Branch `fix/r4-fN`, Basis `main`):
  **F1 Server**, **F2 Shell/Navigation**, **F3 Profile/Neue Session/Einstellungen**,
  **F4 Composer/Transkript**. Danach Merge (Koordinator).
- Welle Fb: **F5 App/E2E** auf dem gemergten Stand (passt E2E an, ergänzt Fälle, voller E2E-Lauf).
- Jeder Befund wird behoben **mit Test** (Gegenprobe: ohne Fix rot, wo sinnvoll) oder begründet
  zurückgestellt (im Ergebnis unter „Zurückgestellt“ mit Grund). NITs sind erwünscht, aber nachrangig.
- Nur die Pfade des eigenen Pakets ändern (Tabelle §2). Neue Dateien in `src/web/lib` nur, wenn sie
  in §2 dem Paket zugeordnet sind. Contracts/Ports/`src/shared/**`/`package.json`/Lockfile: tabu
  (Wunsch → Bericht).
- Ergebnis je Paket in einer eigenen Datei (§3); Commits in Etappen.

## 2. Pakete

| Paket | Pfade (exklusiv in dieser Runde) | Befunde |
|---|---|---|
| **F1 Server** | `src/server/**` ohne `ports.ts`/`backend/{types,fixture}.ts` (inkl. `app/**`, `lib/homeAccess.ts`), `scripts/preflight.ts` | **R4-01** (BLOCKER), **R4-02** (BLOCKER, ADR-121), R4-03 … R4-16 (R4-07: `@shared/secrets` statt Kopie, Logger-Muster, Registrierung in `launchSpecFor`/`checkProfile`; R4-16: ADR-125 in `resolveAttachments`), **R4W-07** (ADR-122, Toast `silent`), **R4W-08** Server-Teil (ADR-123, `consoleCommand` ohne Secret-Werte), R4W-09 Server-Teil (Kopie entfernen), R4W-21 (`DEFAULT_PORT` aus `@shared` in `config.ts`), V3-11 (Fake-Launch-Spec mit `PATH`, `git branch --show-current`-Rückfall), V3-15 (a) README-Hinweis bzw. Handles, (b) `homeAccess`-Schritt |
| **F2 Shell/Navigation** | `src/web/shell/**` **ohne** `{NewSessionDialog,NewSessionForm,EmptyState,SettingsMenu}.tsx` und `shell/new-session/**`; `src/web/{state,lib,playground}/**` (ohne die F3/F4-Dateien unten); `src/web/notifications/**`; `src/web/ui/{context-menu,command-list}.tsx`; neu `src/web/lib/return-focus.ts` | R4W-02 (globaler Drop-Schutz in `ShellEffects`), **R4W-04**/V3-04 (WP-35-Dialoge, Helfer `useReturnFocus` in `lib/return-focus.ts`; nach Auswahl im Quick-Switcher Composer fokussieren), R4W-05 (Conversations-Fehler inline, Hinweis-Region über Modals, `ClientNotice.action?`, Knopf „Töne aktivieren“ in `notifications/delivery.ts`), **R4W-06**/V3-07 (Abo-Limits), R4W-08 Web-Teil (Hinweistext im Namensraum `navigation`), R4W-11 … R4W-15 (R4W-15: `state/settings.ts` alle Top-Level-Felder optimistisch), R4W-20 (`navigation`-Schlüssel, Galerie `playground/demos.tsx` auf vorhandene Schlüssel), R4W-21 (`useProfilesByHost` in `state/hooks.ts`; `profile-colors` bleibt), R4W-23 (`getRename`), V3-03 (Quick-Switcher-Rangfolge), V3-05 (Kopfzeile), V3-12/13/14 (Anteile WP-35: Kontextmenü-Name, Badge-Kontrast, „Archiv (0)“, Gruppenvorrang angeheftet, Texte `navigation`) |
| **F3 Profile/Neue Session/Einstellungen** | `src/web/shell/{NewSessionDialog,NewSessionForm,EmptyState,SettingsMenu}.tsx`, `src/web/shell/new-session/**`, neu `src/web/shell/HostFacts.tsx` (optional), `src/web/features/{profiles,preferences}/**`, `src/web/ui/slider.tsx`, neu `src/web/lib/zod-range.ts` (optional) | **R4W-01** (a `forceMount`, b Schließen-Schutz über `onDirtyChange` mit Inline-Rückfrage, c Abschnittswechsel statt Neu-Montage), R4W-09 Web-Teil (`@shared/secrets`, `lib/secrets.ts` löschen), R4W-16, R4W-17, R4W-18 (`disabledReason` „Fenster öffnen“), R4W-21 (`DEFAULT_PORT` aus `@shared`, Env-Namensregel über `profileInputSchema`), R4W-22 optional (`HostFacts` in eigene Datei), R4W-23 (`isProfileUsable`), R4W-24, V3-01 Teil 2 (Ordner-Browser: Brotkrumen ans Ende, Pfade mit Ellipse; Projekt-Knöpfe), V3-04 (`NewSessionDialog` beim Öffnen aus der Sidebar), V3-06 (Vorgaben-Spalten, klebende Aktionsleiste), V3-12/13/14 (Anteile WP-36/38: `SettingField` `htmlFor`, Labels im Profil-Editor, „Standard Standard“, Testergebnis in Sicht scrollen, Fokus nach Speichern, Texte) |
| **F4 Composer/Transkript** | `src/web/features/{composer,transcript}/**`, `src/web/ui/lightbox.tsx`, neu `src/web/lib/media-types.ts` | **R4W-03**/V3-09 (Tool-Bilder als Vorschau ohne Aufklappen, Name aus `input.file_path`), R4W-02 optional (Drop-Zone über dem ganzen Pane), R4W-21 (`CopyButton` nutzt `lib/clipboard.copyText`; eine Endungstabelle `extensionForMediaType` in `lib/media-types.ts`), R4W-23 (`slashCatalogOf`), R4W-25 (nur prüfen/dokumentieren, Live-Punkt), R4W-26, ADR-125 (Summenprüfung vor dem Senden, Fehler am Chip), **V3-02** (Slash-Menü: Namens-/Alias-Treffer vor Beschreibung, exakter Terminal-Befehl schließt das Menü), V3-04 (`HelpDialog` Fokus zurück), V3-12/13 (Anteile WP-37: `ImageThumb`-Maße, Rate-Limit-Kennung übersetzt, Composer-Sperrtext) |
| **F5 App/E2E** (nach Fa) | `e2e/**`, `playwright.config.ts`, `src/web/{App,main}.tsx`, `src/web/App.test.tsx` | R4W-10 (`setPresence` ohne festen Wait), R4W-19 (`lazy()` für Einstellungsseite und Profil-Editor), R4W-27, R4W-28; E2E-Anpassung an R4W-03 (`phase2-composer.spec.ts:121`), neue Fälle: R4W-01 (Entwurf übersteht Tab-Wechsel, Esc fragt), R4W-02 (Drop daneben navigiert nicht), R4W-04 (Fokus zurück), V3-02 (`/vim` + Enter ohne Esc); voller E2E 2× |

Querschnitt: Live-Prüfpunkte für WP-41 (R4W-02, -07, -12, -18, -25; R4 „Hinweise für WP-41“; V3-11)
sammelt der Koordinator in `docs/wp/WP-41.md`.

## 3. Ergebnisse

Je Paket eine eigene Datei `docs/wp/FIX-R4-F1.md` … `FIX-R4-F5.md` (dieses Dokument bleibt
unverändert): je Befund „behoben“ (Fix + Test, Gegenprobe) oder „zurückgestellt“ (Grund),
Entscheidungen, Checks, Live-Prüfpunkte für WP-41, Wünsche an den Koordinator.
