# e2e – Playwright-Tests in Edge (WP-20c)

E2E-Tests (`*.spec.ts`) mit `@playwright/test` im installierten Microsoft Edge (`channel: 'msedge'`,
headless, siehe `playwright.config.ts`). **Kein Browser-Download, kein Live-`claude`.** Die App läuft
als echter Server-Build (`dist/server.js`) mit dem FakeBackend (interaktives Szenario,
Schlüsselwörter `fake:permission`, `fake:question`, `fake:plan`, `fake:slow`, `fake:crash` … –
`docs/wp/WP-13a.md`).

```powershell
pnpm e2e                                   # alle Fälle (baut dist/ bei Bedarf), ohne e2e/live
pnpm e2e e2e/decisions.spec.ts             # eine Datei
pnpm e2e -g "plan:"                        # nach Titel
$env:PARALLAX_E2E_SKIP_BUILD='1'; pnpm e2e # ohne Build-Prüfung
```

| Datei | Inhalt |
|---|---|
| `global-setup.ts` | baut `dist/` nur, wenn es fehlt oder die Build-ID nicht passt (wie der Launcher; Prüfung und Build unter dem Build-Lock des Checkouts, ADR-092); setzt für Runner und Worker ein eigenes Temp-`PARALLAX_HOME` und Port 0 und entfernt geerbte Server-Steuervariablen (`test/setup/home.ts`, WP22-07) |
| `support/server.ts` | Server je Worker: `node dist/server.js --backend=fake --port=0 --home=<tmp>`, bereit = Lockfile + Health, Anmelde-URL über `POST /api/launcher/code`, Ende über `server.shutdown` mit Prüfung (Exit 0, Lockfile weg, keine Kindprozesse, keine Fehlerzeilen im Log); `adoptE2eServer` für einen vom Launcher gestarteten Server; `reuse` startet einen neuen Server auf dem Home eines beendeten (Neustart-Fälle); `serverSettings` liest die **gespeicherten** Einstellungen (`host.state` eines frischen Node-Clients) – eine Einstellung gilt erst als gespeichert, wenn der Server sie hat, nicht schon bei der optimistischen Anzeige (R4W-27) |
| `support/fixtures.ts` | Fixtures `server` (Worker), `app` (angemeldete Seite), `newWindow()` (zweites Fenster, gleiches oder neues Profil); Diagnose: CSP-Verletzung oder Seitenfehler lässt den Test scheitern, WS-Frames + Server-Log als Artefakte |
| `support/app.ts` | Page-Objects (`ParallaxApp`, `SessionView`) über die Test-Attribute (`data-slot`, `data-action` …); Phase 2: Sidebar-Zeilen, Kontextmenü, Kopfzeilen-Menü, Einstellungsseite |
| `support/presence.ts` | Init-Script `recordNotifications` (Fenster „im Hintergrund“ per `hasFocus`/`visibilityState`, Web Notifications und `AudioContext`-Oszillatoren aufgezeichnet, zuletzt **gesendete** Präsenz aus `clientHello`/`presence`-Frames), `setPresence` (wartet auf den gesendeten Präsenz-Frame statt fester Zeit, R4W-10), `toasts`, `tones`, `clickLastToast` |
| `support/dom.ts` | DOM-Typen für die Browser-Callbacks (tsconfig.tools.json kennt nur Node) und die Rekorder der Init-Scripts als `Window`-Felder (`declare global`, statt `as unknown as`, R4W-27) |
| `recovery.spec.ts` | WP-22 F5 (Absturz von `claude.exe` im Turn → `error`, nächster Prompt startet neu) und F3 (offene Plan-Karte bei „Server beenden“ → nach dem Neustart `needs-resume`, „Fortsetzen & umsetzen“) |
| `phase2-*.spec.ts` | Phase-2-Verifikation (WP-40): Sessions parallel + Statuskette, Navigation, Neue Session + Profile, Composer, Lebenszyklus, Einstellungen – Liste in `docs/wp/WP-40.md` §2; Fälle der Fix-Runde R4 (Profil-Entwurf, Datei-Drop, Fokus nach Esc, `/vim` ohne Esc, Git-Branch) in `docs/wp/FIX-R4-F5.md` |
| `*.spec.ts` | Fälle Phase 1 (Liste in `docs/wp/WP-20c.md`); `notifications.spec.ts` mit Tönen (WP-40) |
| `live/` | **Live-Smoke gegen das installierte `claude`** (WP-22): nur mit `PARALLAX_LIVE=1` (siehe unten) |

Artefakte (Screenshots, Traces, `server-w<n>.log`) landen in `test-results/` (git-ignoriert). Tests,
die Einstellungen ändern oder den Server beenden, starten einen eigenen Server.

## `e2e/live/` – Live-Smoke (nur mit Freigabe)

```powershell
$env:PARALLAX_LIVE='1'; pnpm e2e e2e/live      # ≈ 1,5 min, ≈ 0,01 USD (Haiku)
```

- Ohne `PARALLAX_LIVE=1` ignoriert `playwright.config.ts` den Ordner (`testIgnore`), zusätzlich
  überspringt sich die Datei selbst – `pnpm e2e` ruft nie das echte `claude` auf.
- `live.spec.ts` + `support/live.ts`: echter Server-Build mit `--backend=sdk`, Temp-Home, Port 0,
  `--validate=log`, `--toasts=off`, `ANTHROPIC_MODEL=haiku`; startet nicht, wenn
  `ANTHROPIC_API_KEY`/`_AUTH_TOKEN`/`_BASE_URL` gesetzt sind; prüft nach dem ersten Turn
  `apiKeySource: none` und Haiku, Budget je Prompt `PARALLAX_LIVE_BUDGET_USD` (Default 0,50).
- Abläufe: CLI-Version, Permission „Einmal erlauben“ → echte Datei, AskUserQuestion, Stop, Reload
  mit offener Karte, keine Validierungs-Drops, sauberes Ende. Artefakte `test-results/server-live.log`,
  `live-cost.txt`. Nur mit Nutzer-Freigabe ausführen (Abo-Login, Kosten) – Ablauf und Einordnung:
  `docs/sdk-upgrade.md` Schritt 7.
