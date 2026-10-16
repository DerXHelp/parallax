# src/web/notifications – Benachrichtigungen (WP-20b)

Phase-1-Minimum (Plan „Benachrichtigungen“, Review A.9): Der Server wählt je Ereignis genau ein
Fenster (`notify{delivery: 'in_app' | 'system'}`, `src/server/sessions/notifier.ts`); dieses
Fenster zeigt die Benachrichtigung genau einmal – als In-App-Hinweis über die Notices-API
(`state/notices.ts`, Region des `NotificationCenter`) oder als Web Notification (Edge zeigt sie
als eigenes Popup unten rechts). Präsenz (Fokus, Sichtbarkeit, angezeigte Session, Tippen und ob
dieses Fenster Web Notifications zeigen darf – `systemNotifications`) meldet `state/presence.ts` +
`state/connection.ts`.

| Datei | Inhalt |
|---|---|
| `channel.ts` | `chooseDeliveryChannel({ focused, visible, permission })` (rein): Fenster im Blick → `in_app`, sonst `system`, ohne Berechtigung `in_app`; `NotificationPermissionState` |
| `system.ts` | `SystemNotifier` (`permission`, `requestPermission`, `show({ title, body, tag, onClick })`), `browserNotifier` (Web Notifications), `getSystemNotifier`/`setSystemNotifier` (Tests) |
| `delivery.ts` | `startNotificationDelivery({ store?, notifier?, focusWindow? })` → Stop-Funktion; `IN_APP_NOTIFICATION_MS` (10 s), `noticeIdOf(id)` |
| `permission.ts` | `useNotificationPermission`, `requestNotificationPermission` (nur aus einem Klick; meldet das Ergebnis sofort als Präsenz), `useNotificationHintDismissed`, `dismissNotificationHint` (localStorage `parallax.notifications.permissionHint`) |

Regeln:
- Jede Server-Benachrichtigung wird einmal ausgeliefert (Notice-ID `notify:<id>`, Toast-`tag` =
  `sessionKey`); `notify.clear` zieht Hinweis und Toast zurück; das Anzeigen einer Session
  (Auswahl, „Session anzeigen“, Klick auf den Toast) erledigt ihre Benachrichtigungen.
- Toast-Klick: `window.focus()`, Session wählen (`#session=…`), Toast schließen.
- Berechtigung nur auf Klick: Hinweis-Banner „Benachrichtigungen aktivieren“ (`ShellBanners`) bzw.
  Eintrag im Einstellungsmenü, solange sie `default` ist. Ohne Berechtigung bleibt alles in-app.
- WP22-03/-15 (ADR-082): Im Edge-App-Fenster kann Edge die Berechtigungsanfrage nicht anzeigen
  (Chip in der fehlenden Adressleiste) – der Launcher erlaubt den eigenen Origin deshalb vorab im
  eigenen Profil. Darf ein Fenster trotzdem keine Web Notifications zeigen oder ist gar kein
  Fenster offen, zeigt der **Server** einen nativen Windows-Toast (Absender „Parallax“,
  `src/server/lib/toast.ts`); das Fenster behält seinen In-App-Hinweis. Solange der Server native
  Toasts kann (`HostState.nativeNotifications`), entfällt das Banner. Ein Klick auf den nativen
  Toast schließt ihn nur (Protokoll-Handler `parallax:` ist Opt-in in Phase 2).
- Gestartet von `bootApp()` (App) bzw. in `main.tsx` für den Playground; Texte
  `shell.notifications.*` (`src/web/i18n`). Töne, Einstellungen je Ereignis: Phase 2.
