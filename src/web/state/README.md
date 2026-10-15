# src/web/state – Client-State (WP-14)

Zustand-Store mit Selektoren pro Session, WS-Client mit Resync, ConnectionManager für n Hosts
(Phase 1 nur `local`, `sessionKey = hostId:entryId` nur im Client), Auth-Bootstrap, Präsenz.
Vertrag: `docs/wp/WP-02.md` §10.3; API-Doku für WP-15/16: `docs/wp/WP-14.md` („Ergebnis“).
**In Welle 1b read-only.** Feature-eigener State liegt in `features/<f>/state/`.

| Datei | Inhalt |
|---|---|
| `transport.ts` | `Transport`, `createWebSocketTransport(url, socketFactory?)`, `createMemoryTransport()` (Tests/Playground: `serverSend`, `serverClose`, `sent`, `sentOfType`) |
| `connection.ts` | `createHostConnection(options)` → `ManagedHostConnection` (Handshake, Resync, Reload-Schutz, Backoff, Abos ref-gezählt mit `sinceSeq`, Ops per Animation-Frame über `@shared/sync`, Befehle mit `cmdId` → `ack`, Präsenz), `ClientCommandError`, `errorPayloadOf`, Registry (`registerConnection`, `getConnection`, `retryConnection`, `unregisterConnection`) |
| `store.ts` | `clientStore` (Zustand vanilla), `ClientState`, `HostRecord` (`status`, `phase`, `error` …), `SessionRecord` (`view`, `loading`, `unavailable`) |
| `hooks.ts` | `useHostState`, `useHostRecord`, `useConnectionStatus`, `useSummaries`, `useSummary`, `useDisplayStatus`, `useAttentionCount`, `useSessionSubscription`, `useSessionState`, `useSessionView`, `useSessionDetail`, `useItem`, `useItemIds`, `useDecisions`, `useDecision`, `useSelectedSession`, `useCommand`/`sendCommand`, `useNotifications` |
| `auth.ts` | Auth-Bootstrap nach `docs/architecture.md` §5.1: `consumeAuthCode`, `exchangeAuthCode`, `fetchAuthStatus`, `createAuthBootstrap` |
| `bootstrap.ts` | `bootApp()` – Code aus der URL, Auswahl, Präsenz, Verbindung `local` |
| `clock.ts` | `useNow(intervalMs)`, `useNowUntil(deadlines)` – keine `Date.now()`-Aufrufe im Render |
| `presence.ts` | `startPresenceTracking`, `reportTyping` (für den Composer) |
| `selection.ts` | `#session=…` ↔ Auswahl (`setSelectedSession`, `startSelectionSync`) |
| `settings.ts` | `useSettings`, `updateSettings` (optimistisch, `settings.update`) |
| `theme.ts` | Dark/Light/System: `resolveTheme`, `applyResolvedTheme`, `useThemeController`, `applyInitialTheme` |
| `client-id.ts` | Fenster-ID (`cl_…`, sessionStorage), Reload-Schutz (30 s) |
| `fake-host.ts` | `FakeHost`: In-Memory-Server hinter dem MemoryTransport (nur Tests/Playground) |

Regeln: Ops nur über `applySeqOps`/`applySessionOp` aus `@shared/sync`; Status nur über
`deriveDisplayStatus`; nie `Date.now()` im Render (Clock-Hooks); Befehle nur über
`useCommand`/`sendCommand`, Fehler mit `tError(error.error)` anzeigen.
