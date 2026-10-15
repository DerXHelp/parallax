# e2e – Playwright-Tests in Edge (WP-20c)

E2E-Tests (`*.spec.ts`) mit `@playwright/test` im installierten Microsoft Edge (`channel: 'msedge'`,
headless, siehe `playwright.config.ts`). **Kein Browser-Download, kein Live-`claude`.** Die App läuft
als echter Server-Build (`dist/server.js`) mit dem FakeBackend (interaktives Szenario,
Schlüsselwörter `fake:permission`, `fake:question`, `fake:plan`, `fake:slow` … – `docs/wp/WP-13a.md`).

```powershell
pnpm e2e                                   # alle Fälle (baut dist/ bei Bedarf)
pnpm e2e e2e/decisions.spec.ts             # eine Datei
pnpm e2e -g "plan:"                        # nach Titel
$env:PARALLAX_E2E_SKIP_BUILD='1'; pnpm e2e # ohne Build-Prüfung
```

| Datei | Inhalt |
|---|---|
| `global-setup.ts` | baut `dist/` nur, wenn es fehlt oder die Build-ID nicht passt (wie der Launcher) |
| `support/server.ts` | Server je Worker: `node dist/server.js --backend=fake --port=0 --home=<tmp>`, bereit = Lockfile + Health, Anmelde-URL über `POST /api/launcher/code`, Ende über `server.shutdown` mit Prüfung (Exit 0, Lockfile weg, keine Kindprozesse, keine Fehlerzeilen im Log); `adoptE2eServer` für einen vom Launcher gestarteten Server |
| `support/fixtures.ts` | Fixtures `server` (Worker), `app` (angemeldete Seite), `newWindow()` (zweites Fenster, gleiches oder neues Profil); Diagnose: CSP-Verletzung oder Seitenfehler lässt den Test scheitern, WS-Frames + Server-Log als Artefakte |
| `support/app.ts` | Page-Objects (`ParallaxApp`, `SessionView`) über die Test-Attribute (`data-slot`, `data-action` …) |
| `support/dom.ts` | DOM-Typen für die Browser-Callbacks (tsconfig.tools.json kennt nur Node) |
| `*.spec.ts` | Fälle (Liste in `docs/wp/WP-20c.md`) |

Artefakte (Screenshots, Traces, `server-w<n>.log`) landen in `test-results/` (git-ignoriert). Tests,
die Einstellungen ändern oder den Server beenden, starten einen eigenen Server.
