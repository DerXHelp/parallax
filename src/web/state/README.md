# src/web/state – Client-State (WP-14)

Zustand-Store mit Selektoren pro Session, WS-Client mit Resync, ConnectionManager für n Hosts
(Phase 1 nur `local`, `sessionKey = hostId:entryId` nur im Client), Auth-Bootstrap, Präsenz.
Vertrag: `docs/wp/WP-02.md` §10.3; API-Doku für WP-15/16: `docs/wp/WP-14.md` („Ergebnis“),
Verdrahtung: `docs/wp/WP-20b.md`. Feature-eigener State liegt in `features/<f>/state/`.

| Datei | Inhalt |
|---|---|
| `transport.ts` | `Transport`, `createWebSocketTransport(url, socketFactory?)`, `createMemoryTransport()` (Tests/Playground: `serverSend`, `serverClose`, `sent`, `sentOfType`) |
| `connection.ts` | `createHostConnection(options)` → `ManagedHostConnection` (Handshake, Resync, Reload-Schutz, Backoff, Abos ref-gezählt mit `sinceSeq`, Ops per Animation-Frame über `@shared/sync`, Befehle mit `cmdId` → `ack`, Präsenz), `ClientCommandError`, `errorPayloadOf`, Registry (`registerConnection`, `getConnection`, `retryConnection`, `shutdownServer`, `unregisterConnection`); `shutdownServer()` beendet den Server auch aus einem veralteten Fenster (Phase `version-mismatch`: kurzlebiger Socket nur für `server.shutdown`, Timeout `SHUTDOWN_TIMEOUT_MS`, V2-04) |
| `store.ts` | `clientStore` (Zustand vanilla), `ClientState`, `HostRecord` (`status`, `phase`, `error` …), `SessionRecord` (`view`, `loading`, `unavailable`) |
| `hooks.ts` | `useHostState`, `useHostStates` (alle Hosts, Profile je Host – WP-35), `useProfilesByHost()` (`get(hostId, profileId)`, `size` – Sidebar, Quick-Switcher; R4W-21), `useHostRecord`, `useConnectionStatus`, `useSessionConnectionStatus`, `useSummariesLoaded`, `useSummaries`, `useSummary`, `useSummarySelector`, `useDisplayStatus`, `useAttentionCount`, `useSessionSubscription`, **`useSessionMeta`**, **`useSessionSelector`**, **`useTopLevelItemIds`**, `useChildItemIds`, `useSessionState`, `useSessionView`, `useSessionDetail`, `useItem`, `useItemIds`, `useDecisions`, `useDecision`, `useWindowPresence`, `useSelectedSession`, `useCommand`/`sendCommand`, `useHostCounter(counter, hostId?)` (R3-05), `dismissNotification(id, store?)`, `dismissSessionNotifications(sessionKey, store?)`; reine Selektoren `selectItemTree`, `selectTopLevelItemIds`, `selectSessionMeta`, `selectSessionRecord` |
| `notices.ts` | lokale Hinweise: `showNotice`, `showTextNotice`, `showErrorNotice`, `dismissNotice`, `useNotices` (Anzeige im `NotificationCenter` über modalen Dialogen; auch der In-App-Kanal der Server-Benachrichtigungen); optional ein Knopf je Hinweis: `NoticeOptions.action` = `{ label, run }` (ADR-126) |
| `auth.ts` | Auth-Bootstrap nach `docs/architecture.md` §5.1: `consumeAuthCode`, `exchangeAuthCode` (4xx = abgelehnt, 5xx/Netz = nicht erreichbar, Code bleibt), `fetchAuthStatus`, `createAuthBootstrap` |
| `bootstrap.ts` | `bootApp({ fetch?, createSocket?, notifier?, reload? })` – Code aus der URL, Auswahl, Präsenz, Benachrichtigungs-Zustellung (`src/web/notifications`), Verbindung `local` (WS `ws://<location.host>/api/ws`, im Dev über den Vite-Proxy) |
| `clock.ts` | `useNow(intervalMs)`, `useNowUntil(deadlines)` – keine `Date.now()`-Aufrufe im Render |
| `presence.ts` | `startPresenceTracking(store?, win?, { systemNotifications? })` (Fokus, Sichtbarkeit, Web-Notification-Fähigkeit, WP22-03), `reportSystemNotifications`, `reportTyping` (für den Composer) |
| `selection.ts` | `#session=…` ↔ Auswahl (`setSelectedSession`, `startSelectionSync`) |
| `settings.ts` | `useSettings`, `updateSettings` (jedes Top-Level-Feld des Patches optimistisch, bei Fehler zurück – R4W-15; `settings.update`) |
| `theme.ts` | Dark/Light/System: `resolveTheme`, `applyResolvedTheme`, `useThemeController`, `useResolvedTheme`, `applyInitialTheme` |
| `client-id.ts` | Fenster-ID (`cl_…`, sessionStorage), Reload-Schutz (30 s) |
| `fake-host.ts` | `FakeHost`: In-Memory-Server hinter dem MemoryTransport (nur Tests/Playground) |

Regeln: Ops nur über `applySeqOps`/`applySessionOp` aus `@shared/sync`; Status nur über
`deriveDisplayStatus`; nie `Date.now()` im Render (Clock-Hooks); Befehle nur über
`useCommand`/`sendCommand`, Fehler mit `tError(error.error)` anzeigen. Komponenten lesen Sessions über
`useSessionMeta`/`useSessionSelector`/`useTopLevelItemIds` + `useItem` – `useSessionView`/`useSessionState`
ändern sich mit jedem Delta (architecture §2.3g). Features importieren keine Store-Schreiber (ESLint).
