# src/web/playground – Playground-Route (WP-14)

Entwicklungs-Spielwiese ohne Server: Shell und Feature-Komponenten laufen über
`createMemoryTransport` + `FakeHost` (`src/web/state/fake-host.ts`) mit Daten aus
`@shared/samples`. Nur im Vite-Dev-Server (`import.meta.env.DEV`), im Build nicht enthalten.

**Öffnen:** `pnpm dev:web` (oder `pnpm dev`) → `http://127.0.0.1:5173/#playground`; Deep-Link
für Screenshots: `#playground=<demo-id>`, z. B. `#playground=shell-overview`,
`#playground=shell-streaming`, `#playground=shell-decisions`, `#playground=ui-primitives`,
Feature-Demos `#playground=transcript/<id>`. Theme und Sprache oben rechts.

| Datei | Inhalt |
|---|---|
| `PlaygroundApp.tsx` | Route-UI; findet Feature-Demos per `import.meta.glob('../features/*/playground.tsx', { eager: true })` |
| `types.ts` | `PlaygroundDemo` (`{ id, title, description?, render() }`), `PlaygroundModule` (`{ demos?, slots? }`) |
| `scenarios.ts` | Szenarien `overview` (alle 14 Anzeige-Status), `streaming` (Text-Deltas), `decisions` (drei offene Entscheidungen), `empty`, `setup`, `offline`, `signed-out`, `navigation`, `navigation-external`, `navigation-archived` (WP-35); `PLAYGROUND_ENTRIES`, `PLAYGROUND_SESSION_KEYS`; `ScenarioData.onCommand` (eigene Befehlsbehandlung des FakeHost) |
| `navigation-scenario.ts` | Daten von WP-35: zwei Profile, mehrere Sessions je Projekt, Branches, Modelle, Context 12/72/91 %, angeheftet, archiviert, extern, Abo-Limits, frühere Unterhaltungen; `navigationCommands` (Konsolenbefehl, externe Konsole, Zurückholen, Unterhaltung wechseln, SESSION_BUSY bei laufendem Turn) |
| `navigation-demos.tsx` | Demos `nav-sidebar-flat`, `nav-sidebar-grouped`, `nav-sidebar-archive`, `nav-quick-switcher`, `nav-header-menu`, `nav-conversations`, `nav-session-info`, `nav-external`, `nav-archived` |
| `PlaygroundScenario.tsx` | `<PlaygroundScenario scenario="…">` (für Demos), `startScenario()` (Tests) |
| `demos.tsx` | Demos von WP-14 (Shell-Szenarien, Status-Icons, Primitives) |
| `route.ts` | `#playground`-Parameter (klein, auch im Build importiert) |

**Feature-Demos (WP-15/16):** `src/web/features/<f>/playground.tsx` exportiert
`demos: PlaygroundDemo[]` und optional `slots: Partial<FeatureSlots>` (dann zeigen die
Shell-Demos die echten Komponenten statt der Platzhalter). Titel sind englischer
Entwicklertext ohne `t()`. Beispiel:

```tsx
export const demos: PlaygroundDemo[] = [{
  id: 'streaming',
  title: 'Transcript – streaming text',
  render: () => (
    <PlaygroundScenario scenario="streaming">
      <TranscriptView sessionKey={PLAYGROUND_SESSION_KEYS.streaming} />
    </PlaygroundScenario>
  ),
}];
export const slots: Partial<FeatureSlots> = { Transcript: TranscriptView };
```

Mehrere Worktrees parallel: eigener Port per `PARALLAX_DEV_WEB_PORT` (z. B.
`$env:PARALLAX_DEV_WEB_PORT='5175'; pnpm dev:web`); HMR funktioniert auch in `.worktrees/<wp>`
(`watchIgnores` in `repo.config.ts`). Lokale Hinweise (`showNotice`) erscheinen nur, wo ein
`NotificationCenter` gemountet ist (Shell-Demos; eigene Demos binden ihn bei Bedarf ein).
