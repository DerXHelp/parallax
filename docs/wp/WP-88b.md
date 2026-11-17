# WP-88b – Shell und Verbindung beim Neustart

Teilpaket von WP-87 (Auftrag: `docs/wp/WP-87.md` §2.4, dazu §0.3 Punkt 5, §1.3, §1.5, §1.8, §3 Punkte 1–3).
Branch `wp/88b` von `feature/releases`.

## 1. Ergebnis

### 1.1 Zustand (`src/web/state/store.ts`)
- `HostPhase` + `'restarting'`: Close 4504, das Fenster versucht es bis zur Frist erneut.
- `HostRecord.restartDeadline: number | null` (Epoch-ms; nur in `restarting` gesetzt, sonst `null`). Wie im Auftrag
  vorgesehen; ein absoluter Zeitpunkt statt einer Restdauer, damit eine spätere Anzeige („noch n min“) mit `useNow`
  rechnen kann, ohne dass der Store sekündlich schreibt.
- `nextAttemptAt` gilt jetzt für `reconnecting` und `restarting`.

### 1.2 Verbindung (`src/web/state/connection.ts`)
- `RESTART_RECONNECT_WINDOW_MS = 5 min` (§0.3 Punkt 5), `RESTART_BACKOFF = {initialMs: 2000, maxMs: 2000, factor: 1,
  jitter: 0.5}` → Versuche alle 1–3 s ohne Wachstum, über den vorhandenen Helfer `backoffDelay` (`web/lib/backoff.ts`).
- Close 4504 → `failAllPending('CONNECTION_LOST')`, Frist setzen, Timer für den Ablauf, erster Versuch nach 1–3 s.
- Jeder Versuch ist der normale `beginAttempt`: erst `GET /api/auth/status`, dann der Socket. Während des Neustarts
  bleiben die Zwischenschritte (`checking-auth`, `connecting`, `reconnecting`) als `restarting` sichtbar – ein Banner,
  kein Wechsel zwischen „startet neu“ und „Verbindung verloren“ im Sekundentakt. Das übernimmt `setPhase` zentral;
  jede andere Phase (`open`, `unauthenticated`, `version-mismatch`, `server-stopped`, `stopped`) beendet den Neustart.
- Fehlversuche (Server nicht erreichbar, 1006, Hello-Timeout) bleiben `restarting`. `hello` läuft wie heute:
  neue `serverInstanceId` → Full-Resync, andere Build-ID oder Protokollversion → Neuladen mit Schleifenschutz.
- Frist abgelaufen → `server-stopped` mit `makeError('UPDATE_RESTART_FAILED', { reason: 'timeout' })`. Ein laufender
  Versuch wird verworfen (`generation++`, Socket zu); eine später eintreffende Anmeldeprüfung bewirkt nichts mehr.
  „Neu verbinden“ (`retryNow`) startet danach einen normalen Versuch ohne Frist.
- `statusOf('restarting')` = `reconnecting`. 4503 unverändert.
- **Zusätzlich:** `send()` lehnt in `restarting` sofort mit `CONNECTION_LOST` ab. Der nächste Server ist eine neue
  Instanz, deren Full-Resync den Befehl ohnehin verwerfen würde – sonst hinge er bis zu 60 s bis `COMMAND_TIMEOUT`.
- `retryNow()` in `restarting` überspringt nur die Wartezeit; läuft gerade ein Versuch (kein Timer), passiert nichts.
- **Mehrere Fenster:** Jedes Fenster hat eigene Timer, eigene Frist und den Schleifenschutz in seinem
  `sessionStorage`; der Zufallsanteil verteilt die Versuche, damit nicht alle Fenster im selben Takt anklopfen.

### 1.3 Oberfläche
- `ShellBanners.tsx`: `RestartBanner` („Parallax startet neu …“ + Beschreibung, `Banner tone="info"` → `role="status"`,
  `Spinner` aus `src/web/ui` an Stelle des Banner-Symbols, kein „Jetzt erneut versuchen“, kein Countdown). Danach der
  Slot `UpdateBanner` aus `useFeatureSlots()`, vor Setup-Hinweis und Server-Warnungen.
- `HostGate.tsx`: ganze Seite für `restarting` ohne `everConnected` (Titel, Beschreibung, Spinner). Nach Ablauf zeigt
  die vorhandene Seite „Server beendet“ zusätzlich `Alert tone="error"` mit `tError(host.error)`, wenn der Fehler
  `UPDATE_RESTART_FAILED` ist (4503 bleibt ohne Fehlertext).
- `Sidebar.tsx`: neue Komponente `SidebarUpdateNotice({compact})` rendert den Slot `UpdateNotice` in einem Rahmen mit
  `empty:hidden` – rendert der Slot nichts (Platzhalter), verschwindet der Rahmen samt Abstand. Die breite Sidebar
  rendert ihn als eigene Zeile direkt unter der Titelzeile (`compact={false}`); in der Titelzeile der w-72-Sidebar ist
  neben den vier Symbolknöpfen kein Platz für einen Textknopf.
- Keine neuen i18n-Texte: `connection.restartingTitle`/`restartingDescription` (87-0) und `errors.UPDATE_RESTART_FAILED`
  reichen.

## 2. Abweichungen und offene Punkte
- **Schmale Leiste:** Die Leiste (`SidebarRail`) liegt in `src/web/shell/SidebarFrame.tsx`, nicht in `Sidebar.tsx`, und
  gehört nicht zu 88b. Vorbereitet ist `SidebarUpdateNotice` (exportiert aus `Sidebar.tsx`); in 89 genügt in
  `SidebarRail` direkt nach dem Knopf „Sitzungen zeigen“ eine Zeile `<SidebarUpdateNotice compact />` (Import aus
  `./Sidebar`, das `SidebarFrame` schon importiert).
- `UPDATE_RESTART_FAILED` trägt nach dem Contract `version` und `reason`; der Client kennt die Zielversion nicht sicher
  (Update oder Rückweg) und setzt nur `reason: 'timeout'`, wie in §2.4 vorgegeben.
- Die Anmeldeprüfung (`fetchAuthStatus`) hat keinen eigenen Timeout. Hängt sie, bleibt der Versuch bis zur Frist stehen;
  die Frist beendet ihn sicher. Für den lokalen Server (Verbindung abgelehnt statt hängend) unkritisch.
- Ein Neuladen mitten im Neustart landet im normalen Reconnect (§3 Punkt 1): ohne `everConnected` zeigt das Fenster
  „Server nicht erreichbar“ mit Backoff bis 15 s, bis der neue Server antwortet.

## 3. Tests
- `src/web/state/connection.test.ts` (+8): 4504 → `restarting` (Status `reconnecting`, Frist, offene und neue Befehle
  `CONNECTION_LOST`), Versuche mit Anmeldeprüfung im 2-s-Takt, Fehlversuche bleiben `restarting`, `hello` gleiche
  Build-ID → `open`; Streuung 1–3 s; neue Build-ID bzw. Protokollversion → Neuladen; Ablauf → `server-stopped` mit
  `UPDATE_RESTART_FAILED {reason: 'timeout'}`, danach keine Versuche, `retryNow` normal; Ablauf verwirft offenen Socket
  und ausstehende Anmeldeprüfung; `retryNow` ohne Doppelversuch; zwei Fenster unabhängig; 4503 unverändert.
- `src/web/shell/HostGate.test.tsx` (4), `ShellBanners.test.tsx` (3), `Sidebar.test.tsx` (3): Seite und Banner für
  `restarting`, Fehlertext nach Ablauf, Slots `UpdateBanner`/`UpdateNotice` (auch `compact`), leerer Rahmen beim
  Platzhalter.
- Gelaufen: `vitest run src/web/state src/web/shell` (61 Dateien, 409 Tests), `eslint` und `prettier` auf den
  geänderten Dateien, `tsc -b`.

## 4. Für den Koordinator
- README: `src/web/state/README.md` (Phase `restarting`, `restartDeadline`, Close 4504) und `src/web/shell/README.md`
  (`RestartBanner`, Slot `UpdateBanner` in `ShellBanners`, `SidebarUpdateNotice`).
- `docs/architecture.md` §5: 4504 → `restarting`, Frist 5 min, Versuche 1–3 s, Ablauf → `server-stopped` mit
  `UPDATE_RESTART_FAILED`; `send()` lehnt in `restarting` sofort ab.
