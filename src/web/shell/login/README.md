# src/web/shell/login – Anmelden aus Parallax (WP-70)

Anmeldung eines Profils ohne Terminal: Knopf „Anmelden“ an Anmeldefehlern und der kleine,
nicht-modale Anmelde-Dialog. Der Server führt den Ablauf (`profile.login`, `profile.loginCode`,
`profile.loginCancel`, `src/server/host/login.ts`) und meldet den Zustand in
`ProfileSummary.login` (`idle | starting | waiting | verifying | done | failed`, nur `subscriptionType`,
nie E-Mail/Organisation).

| Datei | Inhalt |
| --- | --- |
| `LoginButton.tsx` | `LoginButton({profileId, hostId?, since?})` – Knopf „Anmelden“ (`navigation.actions.signIn`, Start-Chunk, darum klein); Klick → Shell-Anfrage `login` (`modal: true`, wenn er in einem modalen Dialog sitzt – Neue Session, Einstellungen). Mit `since` (Zeit des Fehlers) verschwindet er, sobald das Profil danach angemeldet wurde (`login.state === 'done'`, `login.at >= since`). `needsSignIn(claude)` – `claude` läuft, aber `auth.state` ist `logged_out`/`error` |
| `LoginDialog.tsx` | Lazy-Chunk (NavigationLayer): startet beim Öffnen `profile.login` (einmal, auch unter StrictMode), zeigt „wird gestartet“ bis der Host einen neueren Zustand meldet (nie das alte „angemeldet“), dann „Anmeldung im Browser geöffnet – warte auf Abschluss …“ mit „Link erneut öffnen“ (`openExternalLink` → Host-Befehl `link.open`), „Link kopieren“ (manueller Link), Feld „Code einfügen“ (`maxLength` `LOGIN_CODE_CHARS`), „Code wird geprüft …“, Erfolg „Angemeldet (Max)“, Fehler als `Alert` (`role="alert"`, Text über `tError`), „Erneut versuchen“. „Abbrechen“ beendet den Ablauf (`profile.loginCancel`); Schließen blendet nur aus (eine Weiterleitung an das CLI kann ihn noch abschließen). Nicht-modal (kein Overlay, Klicks ins Fenster schließen ihn nicht, oben rechts), modal nur auf Wunsch der Anfrage; Fokus zurück über `useReturnFocus` |
| `i18n/` | Lazy-Namensraum (`useLoginT`, `translateFrom`, ADR-183; in `LAZY_NAMESPACES` von `src/web/i18n/bundle.test.ts`) – Texte des Dialogs, nie im Start-Chunk |
| `login.test.tsx` | Knopf (Anfrage, `modal`, verschwindet nach Anmeldung), Dialog gegen den FakeHost (warten, Code → angemeldet, abgelehnter Code, Abbrechen, abgelehnter Befehl, Deutsch, kein altes „angemeldet“), Lazy-Namensraum |

Knöpfe sitzen an: Fehler-Items `CLAUDE_AUTH_FAILED`/`CLAUDE_NOT_LOGGED_IN` im Transkript
(`features/transcript/items/SystemRow.tsx`), Einrichtungshinweis (`ShellBanners.tsx`), Neue Session
(`NewSessionForm.tsx`), Profiltest (`features/profiles/components/TestResult.tsx`); im Remote-Control-Menü
und den „…“-Menüs als Aktion `signIn` (nur bei `REMOTE_CONTROL_AUTH`, `navigation/session-actions.tsx`).
