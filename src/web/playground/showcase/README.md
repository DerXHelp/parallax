# src/web/playground/showcase – README-Screenshots (WP-68)

Erfundener, aber glaubwürdiger Arbeitstag eines Entwicklers (Donnerstag, 12.11.2026, 14:37): vier
Projekte unter `D:\dev\` (`nordlicht-shop` – Next.js, `fahrplan-api` – FastAPI, `vereinsapp` –
Flutter, `infra` – Terraform), acht laufende und drei archivierte Sessions in allen interessanten
Zuständen. Oberfläche und Inhalte deutsch, Code und CLI-Ausgaben englisch. Keine echten Konten,
Projekte oder Namen; nirgends sichtbar „Fake“, „Sample“ oder „Demo“ (Test in `showcase.test.tsx`).

**Öffnen:** `pnpm dev:web` → `#playground=showcase-overview&bare` (bzw. `showcase-plan`,
`showcase-files`). **Bilder neu erzeugen:**
`pnpm exec tsx --tsconfig tsconfig.tools.json scripts/screenshots.ts` (`scripts/README.md`).

| Datei | Inhalt |
|---|---|
| `clock.ts` | `SHOWCASE_NOW` – die Uhr der Screenshots (das Skript hält eine Kopie) |
| `data.ts` | Szenario-Daten: Host-Zustand (`backend: 'sdk'`, Deutsch, Theme „System“, Abo-Limits), Summaries, Snapshots mit Details, offene Entscheidungen (Freigabe, Plan v2), Plan-Versionen und Dateien-Index (`prepareShowcaseHost`) |
| `transcripts.ts` | Transkripte der acht Sessions (Schritt-Gruppen, Diff, laufendes Bash, Plan v1 abgelehnt/v2 offen, Explore-Agent im Hintergrund, Seitenfrage, Prompt aus der Claude-App) |
| `transcript-builder.ts` | kleiner Baukasten für Items mit festen IDs und Zeiten relativ zu `now` |
| `plans.ts` | Plan v1 und v2 der Session „Rate-Limiting für /v2/connections“ |
| `files.ts` | Dateien der Projekte (Viewer, FileLinks) mit Änderungszeit; `src/web/state/fake-host.ts` nimmt sie in jede Dateitabelle auf (die statische FileSource des Files-Playgrounds liest die Tabelle beim Modul-Laden) |
| `demos.tsx` | `showcase-overview`, `showcase-plan`, `showcase-files`: die ganze App (`AppShell`) über dem Szenario, Sidebar nach Projekt gruppiert, je Demo Session und Seitenpanel; `data-showcase-ready` für das Skript |
| `showcase.test.tsx` | Schemas, verbotene Wörter, `&bare`, die drei Demos in happy-dom |

Hinweise für Änderungen: Die Kopfzeile der App ist bei 1440 px knapp – lange Live-Zeilen,
Titel oder volle Modell-IDs kürzen dort Titel und Modell mit „…“ (darum `summary.model = null`,
die volle ID steht im `init`). Sichtbar wird nur das Ende des Transkripts; was oben herausfällt,
zuerst kürzen.
