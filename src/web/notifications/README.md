# src/web/notifications – Benachrichtigungen (WP-20b, Töne WP-38)

Der Server wählt je Ereignis genau ein Fenster und den Kanal (`notify{delivery: 'in_app' | 'system'}`,
`src/server/sessions/notifier.ts`) und wendet dabei die Einstellungen an (ADR-109: „Nicht stören“,
Toast je Ereignis, Fokus-Regel `focusedElsewhere`, Fertig-Schwelle). Dieses Fenster zeigt die
Benachrichtigung genau einmal – als In-App-Hinweis über die Notices-API (`state/notices.ts`, Region
des `NotificationCenter`) oder als Web Notification (Edge zeigt sie als eigenes Popup unten rechts) –
und spielt den Ton. Präsenz (Fokus, Sichtbarkeit, angezeigte Session, Tippen und ob dieses Fenster
Web Notifications zeigen darf – `systemNotifications`) meldet `state/presence.ts` +
`state/connection.ts`.

| Datei | Inhalt |
|---|---|
| `channel.ts` | `chooseDeliveryChannel({ delivery, focused, visible, permission, focusedElsewhere, osAllowed })` (rein): folgt dem Server und korrigiert nur veraltete Präsenz – `system` an ein Fenster im Blick → `in_app` (außer `focusedElsewhere: 'system'`), `in_app` an ein Fenster im Hintergrund → `system`, wenn OS-Benachrichtigungen erlaubt sind (nie gegen „Nicht stören“); ohne Berechtigung `in_app` |
| `system.ts` | `SystemNotifier` (`permission`, `requestPermission`, `show({ title, body, tag, silent?, onClick })`), `browserNotifier`, `getSystemNotifier`/`setSystemNotifier` (Tests) |
| `sounds.ts` | Töne (ADR-109): `SOUNDS` (fünf synthetisierte Klänge, Oszillator + Hüllkurve, ≤ 600 ms), `playSound(id, volume)` → `'played' \| 'locked' \| 'unsupported'`, `unlockAudio()`, `installAudioUnlock(window)` (erstes `pointerdown`/`keydown`), `audioState()`, `subscribeAudioUnlock`, `SoundPlayer` (`state`, `play`, `onUnlock`, optional `unlock`)/`webAudioPlayer`, `resetAudio()` (Tests) |
| `delivery.ts` | `startNotificationDelivery({ store?, notifier?, focusWindow?, sounds? })` → Stop-Funktion; `IN_APP_NOTIFICATION_MS` (10 s), `noticeIdOf(id)`, `SOUNDS_LOCKED_NOTICE_ID` |
| `permission.ts` | `useNotificationPermission`, `requestNotificationPermission` (nur aus einem Klick; meldet das Ergebnis sofort als Präsenz), `useNotificationHintDismissed`, `dismissNotificationHint` (localStorage `parallax.notifications.permissionHint`) |
| `testing.ts` | nur Tests: `FakeAudioContext` (zeichnet den Web-Audio-Graphen auf) |

Regeln:
- Jede Server-Benachrichtigung wird einmal ausgeliefert (Notice-ID `notify:<id>`, Toast-`tag` =
  `sessionKey`); `notify.clear` zieht Hinweis und Toast zurück; das Anzeigen einer Session
  (Auswahl, „Session anzeigen“, Klick auf den Toast) erledigt ihre Benachrichtigungen.
- Ton bei jeder Benachrichtigung an dieses Fenster (`in_app` und `system`), wenn
  `events[kind].sound` und nicht „Nicht stören“, mit `soundId` und `volume` der Einstellungen des
  Hosts. Eigene Web Notifications sind dann `silent` (ebenso ohne Ton für das Ereignis); nur wenn
  der Ton gewünscht, aber gesperrt oder Web Audio nicht verfügbar ist, darf der Browser klingen.
- Autoplay: Töne sind bis zur ersten Interaktion im Fenster gesperrt; der `AudioContext` entsteht
  erst danach beim ersten Ton und wird in Pausen suspendiert. Ein gesperrter Ton zeigt einmal je
  Fensterlauf den Hinweis „Töne aktivieren“ (`preferences.sounds.locked`, bleibt bis zur
  Interaktion, die ihn auch schließt) mit gleichnamigem Knopf (`ClientNotice.action`,
  `navigation.notices.enableSounds`, ruft `SoundPlayer.unlock` – ADR-126, R4W-05). Seit ADR-120 nur
  noch Rückfall für Fenster, die nicht der Launcher geöffnet hat. Vorhören (Einstellungsseite) ruft
  `unlockAudio()` im Klick.
- Toast-Klick: `window.focus()`, Session wählen (`#session=…`), Toast schließen.
- Berechtigung nur auf Klick: Hinweis-Banner „Benachrichtigungen aktivieren“ (`ShellBanners`) bzw.
  Eintrag im Einstellungsmenü, solange sie `default` ist. Ohne Berechtigung bleibt alles in-app.
- WP22-03/-15 (ADR-082): Im Edge-App-Fenster kann Edge die Berechtigungsanfrage nicht anzeigen
  (Chip in der fehlenden Adressleiste) – der Launcher erlaubt den eigenen Origin deshalb vorab im
  eigenen Profil. Darf ein Fenster trotzdem keine Web Notifications zeigen oder ist gar kein
  Fenster offen, zeigt der **Server** einen nativen Windows-Toast (Absender „Parallax“,
  `src/server/lib/toast.ts`, stumm ohne Ton für das Ereignis); das Fenster behält seinen
  In-App-Hinweis. Solange der Server native Toasts kann (`HostState.nativeNotifications`), entfällt
  das Banner. Ein Klick auf den nativen Toast öffnet die Session nur mit
  `settings.notifications.openOnClick` (Protokoll-Handler `parallax:`, ADR-109).
- Gestartet von `bootApp()` (App) bzw. in `main.tsx` für den Playground; Texte
  `shell.notifications.*` (`src/web/i18n`) und `preferences.sounds.*`.
