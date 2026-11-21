# src/web/playground/showcase – README-Screenshots (WP-68, WP-118)

Erfundener, aber glaubwürdiger Arbeitstag eines Entwicklers (Donnerstag, 12.11.2026, 14:37): vier
Projekte unter `D:\dev\` (`nordlicht-shop` – Next.js, `fahrplan-api` – FastAPI, `vereinsapp` –
Flutter, `infra` – Terraform), acht laufende und drei archivierte Sessions in allen interessanten
Zuständen. Oberfläche und Inhalte deutsch, Code und CLI-Ausgaben englisch. Keine echten Konten,
Projekte oder Namen; nirgends sichtbar „Fake“, „Sample“ oder „Demo“ (Test in `showcase.test.tsx`).
Seit WP-118: die Session „Produktfilter mit Mehrfachauswahl“ arbeitet im Worktree
`nordlicht-shop\.claude\worktrees\multi-filter` (Branch `multi-filter`), „Flaky Test …“ ist
ungelesen, `dev\infra` stummgeschaltet; der Host meldet `features {git, search, overview}`.

**Öffnen:** `pnpm dev:web` → `#playground=showcase-overview&bare` (bzw. `showcase-plan`,
`showcase-review`, `showcase-files`, `showcase-search`). **Bilder neu erzeugen:**
`pnpm exec tsx --tsconfig tsconfig.tools.json scripts/screenshots.ts` (`scripts/README.md`).

| Datei | Inhalt |
|---|---|
| `clock.ts` | `SHOWCASE_NOW` – die Uhr der Screenshots (das Skript hält eine Kopie) |
| `data.ts` | Szenario-Daten: Host-Zustand (`backend: 'sdk'`, Deutsch, Theme „System“, Zoom 85 %, Abo-Limits, stummes Projekt), Summaries, Snapshots mit Details (Review-Kommentare der Filter-Session), offene Entscheidungen (Freigabe, Plan v2), Plan-Versionen und Dateien-Index (`prepareShowcaseHost`); `onCommand` für `git.*`, `review.*`, `search.query`, `session.setUnread` |
| `review.ts` | WP-118: Worktree, Diff (drei Dateien), Git-Status (2 Commits vor `origin`) und zwei Review-Kommentare (einer gesendet, einer offen) der Filter-Session; `showcaseGitCommand`, `showcaseReviewCommand` (Antworten wie der Server, Review als Ops) |
| `search.ts` | WP-118: `showcaseSearch` – Volltextsuche über die Showcase-Daten wie der Such-Worker des Servers (Titel, Fazits, Prompts, Antworten, Seitenfragen; Snippet mit Treffern, neueste zuerst) |
| `slots.ts` | WP-118: `SHOWCASE_SLOTS` – `ChangesPanel` und `SearchDialog` der Features per `import.meta.glob` (der Playground lädt sonst nur `features/*/playground.tsx`, statische Feature-Importe verbietet ESLint) |
| `transcripts.ts` | Transkripte der acht Sessions (Schritt-Gruppen, Diff, laufendes Bash, Plan v1 abgelehnt/v2 offen, Explore-Agent im Hintergrund, Seitenfrage, Prompt aus der Claude-App, Review-Nachricht der Filter-Session) |
| `transcript-builder.ts` | kleiner Baukasten für Items mit festen IDs und Zeiten relativ zu `now` |
| `plans.ts` | Plan v1 und v2 der Session „Rate-Limiting für /v2/connections“ |
| `files.ts` | Dateien der Projekte (Viewer, FileLinks) mit Änderungszeit, Pfad des Filter-Worktrees; `src/web/state/fake-host.ts` nimmt sie in jede Dateitabelle auf (die statische FileSource des Files-Playgrounds liest die Tabelle beim Modul-Laden) |
| `demos.tsx` | `showcase-overview`, `showcase-plan`, `showcase-review`, `showcase-files`, `showcase-search`: die ganze App (`AppShell`) über dem Szenario, Sidebar nach Projekt gruppiert und 336 px breit, je Demo Session und Seitenpanel bzw. Suchdialog; `data-showcase-ready` für das Skript |
| `showcase.test.tsx` | Schemas, verbotene Wörter, Antworten auf `git.*`/`review.*`/`search.query`, `&bare`, die fünf Demos in happy-dom |

Hinweise für Änderungen: Die Kopfzeile der App ist bei 1440 px knapp – lange Live-Zeilen,
Titel oder volle Modell-IDs kürzen dort Titel und Modell mit „…“ (darum `summary.model = null`,
die volle ID steht im `init`). Zoom 85 % und Sidebar 336 px sind so gewählt, dass die deutschen
Filter-Schalter und die Kopfzeile auch mit offenem Seitenpanel nicht abschneiden. Sichtbar wird nur
das Ende des Transkripts; was oben herausfällt, zuerst kürzen. Diff-Zeilen im Tab „Änderungen“
höchstens etwa 60 Zeichen, sonst brechen sie um. Suchtreffer: das Suchwort früh im Text, sonst
liegt es hinter dem „…“ der Zeile.
