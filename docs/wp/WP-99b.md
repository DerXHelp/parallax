# WP-99b – Eingebettetes Terminal: Web

Auftrag: `docs/wp/WP-99.md` („Aufteilung“, 99b), Branch `feature/konsole`, 20.11.2026. Grundlage: Contract
`src/shared/terminal.ts` (Protokoll v1, unverändert), Web-Gerüst des Koordinators (Slot `TerminalPanel`,
`useTerminalAvailable`, Tokens `--terminal-*`). Server: `docs/wp/WP-99a.md`.

## Ergebnis

Neu: `src/web/features/terminal/**` (Aufbau in der `README.md` des Ordners). Keine Änderung außerhalb des Ordners,
keine neue Abhängigkeit (xterm 6.0.0 und addon-fit 0.11.0 sind schon da), keine Contract-Änderung.

- **Slot:** `index.ts` exportiert `TERMINAL_SLOTS = { TerminalPanel }`, `React.lazy(() => import('./TerminalPanel'))`
  in `Suspense` ohne Fallback (wie `TASKS_SLOTS`). `index.ts` importiert statisch nur React (Test `index.test.ts`).
  xterm, `@xterm/xterm/css/xterm.css` und der Namensraum `i18n/` liegen im Lazy-Chunk.
- **Panel:** ein Socket je montiertem Panel; das erste leere `terminals` nach dem Start öffnet ein Terminal mit
  `settings.console.defaultShell` (einmal je Mount). Danach Leerzustand mit einem Knopf je Shell. Leiste der Terminals
  mit „+“ (Standard zuerst), Exit-Leiste, Kontextmenü, Serverfehler inline, `available: false` → Hinweis.
- **Socket:** zod für jeden Text-Frame, Unbekanntes wird gezählt (`ignored`) und ignoriert; binäre Frames über
  `decodeTerminalFrame` je Kanal; Reconnect mit `backoffDelay` (`DEFAULT_BACKOFF`), danach `hello` und `attach` aller
  montierten Ansichten. 4404 und 4426 sind endgültig (Hinweis statt neuer Versuche).
- **Ansicht:** Engine-Adapter `lib/engine.ts` (xterm, nur DOM-Renderer, `windowsPty: conpty`), `FakeEngine` für
  happy-dom. `attach` mit eingepasster Größe, `ResizeObserver` → Fit → `resize` (100 ms entprellt), Zoom → Schrift neu
  und Fit, Theme über `MutationObserver` auf die Klasse von `<html>`.

### Andocken für den Koordinator

- `App.tsx`: `TerminalPanel: bounded(TERMINAL_SLOTS.TerminalPanel, bySessionKey)` (Import
  `TERMINAL_SLOTS` aus `./features/terminal`).
- `src/web/i18n/bundle.test.ts`, `LAZY_NAMESPACES`:
  `{ dir: '/src/web/features/terminal/i18n/', chunk: '/src/web/features/terminal/TerminalPanel.tsx' }`.
- `data-slot`: `terminal-panel`; `terminal-view` mit `data-active="true"` (Alt+T fokussiert dessen
  `.xterm-helper-textarea`), `data-terminal-id`, `data-state`; weitere in der Ordner-README.

## Entscheidungen und Abweichungen

- **Ctrl+V ohne Clipboard-API:** Der Tasten-Handler lässt xterm die Taste auslassen (kein `^V`) und ruft kein
  `preventDefault`; der Browser feuert sein natürliches `paste`, xterms Paste-Handler fügt ein (Bracketed Paste,
  Zeilenenden). So fragt Chrome nie nach der Berechtigung „Zwischenablage lesen“. Nur der Menüpunkt „Einfügen“ nutzt
  `navigator.clipboard.readText()`; verweigert der Browser, erscheint ein Hinweis („mit Strg+V einfügen“).
- **Ctrl+C:** mit Auswahl kopieren (`copyText`) und die Auswahl aufheben, damit das nächste Ctrl+C wieder unterbricht
  (wie Windows Terminal); ohne Auswahl `^C`. Ctrl+Shift+C kopiert immer.
- **Tasten an die App:** Alt+T, Alt+K, Alt+N, Alt+1…9 und die Zoom-Tasten (`zoomKeyAction`). Ctrl+K (Readline: Zeile
  löschen) und Alt+B/Alt+F (Wort links/rechts) bleiben bewusst in der Shell. Die einzige F-Taste der App (F2
  „Umbenennen“) ist nicht für Textfelder registriert und feuert aus dem Terminal ohnehin nicht – sie bleibt bei der
  Shell.
- **Esc:** xterm verarbeitet Esc selbst und stoppt das Ereignis. Zusätzlich legt die Ansicht bei jedem Fokus im Host
  (Capture-Phase von `focus`) einen Esc-Handler mit `scopeRef` oben auf den Stapel der Registry; er meldet „erledigt“,
  der Handler des Seitenpanels kommt nicht dran. Auf den Tabs der Leiste schließt Esc das Panel wie gewohnt.
- **Fokus:** beim Mount auf das aktive Terminal, nach dem eigenen `opened` und beim Klick auf einen Tab; nicht bei
  Pfeiltasten in der Leiste (sonst ginge die Tastaturbedienung der Tabs verloren). Nie weg von einem Element außerhalb
  des Seitenpanels (z. B. Composer, falls der Nutzer während des Verbindens weitergegangen ist).
- **Tab-Nummern** zählen je Shell und bleiben, solange das Terminal lebt: Schließen von „cmd 1“ benennt „cmd 2“ nicht
  um; ein neues cmd bekommt die kleinste freie Nummer. Sie überstehen das Schließen und Wiederöffnen des Panels.
- **Ansichten bleiben montiert:** Alle Terminals der Leiste haben eine Ansicht (inaktive versteckt); die Engine öffnet
  und `attach` geht erst, wenn eine Ansicht zum ersten Mal aktiv ist. Danach empfängt sie weiter, ein Tab-Wechsel
  braucht kein Replay.
- **Schrift:** xterm misst die Zellgröße einmal beim Öffnen und nie wieder für eine später geladene Schrift. Die Ansicht
  wartet deshalb höchstens 1,5 s auf `document.fonts.load()` der Mono-Schrift, bevor sie xterm öffnet.
- **Exit-Code als Text:** Codes kommen als vorzeichenlose 32 Bit (Ctrl+C-Ende 3221225786, WP-99a); als Zahl würde
  `t()` sie mit Tausenderpunkten formatieren.
- **Neu starten** = `close`, dann `open` derselben Shell; die Grenze zählt das schließende Terminal nicht mit.
- **„+“ an der Grenze:** Der Knopf bleibt bedienbar, im Menü steht die Grenze, die Shells sind deaktiviert (ein
  deaktivierter Knopf zeigt keinen Tooltip).
- **`detach` beim Unmount des ganzen Panels:** React räumt bei einer Löschung die Eltern zuerst auf. `stop()` des
  Controllers schickt deshalb `detach` für jede Ansicht, solange der Socket offen ist, und schließt ihn dann.
- **Screenreader-Modus** gilt je Fenster für alle Terminals (localStorage `parallax.terminal.screenReader`).
- **Store je Session, Besitz je Mount:** Der Store überlebt das Schließen des Panels (aktives Terminal, Tab-Nummern).
  Damit ein neues Panel im ersten Render nicht die Liste des alten zeigt (Ansichten würden Engines öffnen und gleich
  wieder verwerfen), trägt der Store die ID des laufenden Controllers (`owner`); bis dessen `start` lief, zeigt das
  Panel nichts.

## Wünsche an den Koordinator (außerhalb des Ordners)

- `eslint.config.js`: `'terminal'` in `FEATURES`, Blöcke für `src/web/features/terminal/**` (mit `noStoreWriters`)
  und die Tests wie bei `tasks`. Ohne Block gelten nur die allgemeinen Web-Regeln (keine Feature-Grenze).
- Alt+T im Shortcut-Register mit `allowInInputs: true`, sonst feuert es aus dem Terminal (Textarea) nicht.
- `sampleTerminalInfo`/`sampleTerminalId` in `@shared/samples` wären für Server- und Web-Tests gemeinsam nützlich;
  bis dahin stehen sie in `testing.ts` (feste IDs `tm_…`, `SAMPLE_TIME`).
- `src/web/features/README.md`: Zeile für `terminal`.

## Stolpersteine

- `tsc` war nicht erlaubt; die Typen sind von Hand geprüft (u. a. explizite Rückgabetypen in `map`-Callbacks mit
  Literal-Zuständen). Der volle `pnpm check` steht beim Koordinator aus.
- happy-dom feuert bei `focus()` kein `focusin`; deshalb `focus` in der Capture-Phase. Der Effekt dafür steht vor den
  Effekten, die die Engine öffnen und fokussieren.
- xterm stoppt alle Tasten, die es verarbeitet (im Screenreader-Modus nur solche mit Ctrl/Alt). Was an die App soll,
  muss der eigene Tasten-Handler mit `false` vorbeilassen.
- Die Fit-Addon misst das Elternelement des `.xterm`-Elements: Der Host hat kein Padding und ist absolut positioniert
  (feste Höhe auch in Flex-Layouts); der Abstand liegt am äußeren Element.

## Checks

- `pnpm exec vitest run src/web/features/terminal`: 8 Dateien, 38 Tests grün (ohne act-Warnungen).
- `pnpm exec eslint src/web/features/terminal`: sauber. `prettier --write` über den Ordner.
- typecheck, voller Testlauf, Build, E2E: Koordinator.
