# Changelog

Alle nennenswerten Änderungen an Parallax. Versionen nach SemVer, neueste zuerst. Aufbau nach „Keep a Changelog“;
Pflege und Release-Ablauf stehen in `docs/wp/WP-83.md` §4.

## [Unveröffentlicht]

### Neu
- Der Zoom lässt sich unter Einstellungen → Allgemein wählen (50–200 %, gilt für alle Fenster); Strg+Mausrad und
  Strg+Plus/Minus ändern diese Einstellung statt Chromes eigenen Zoom, Strg+0 setzt auf 100 % zurück (WP-92).
- Pläne lassen sich im Tab „Plan“ kommentieren: Text markieren und kommentieren (Taste C) oder streichen, „+“ am Rand
  für eine ganze Stelle; „Weiter planen“ schickt alle Anmerkungen mit Abschnitt, Zeile und Zitat samt Nachrichtentext
  an Claude, und der Vergleich zur nächsten Version zeigt, was angemerkt war (WP-93).
- Das Seitenpanel lässt sich mit „Breit“ neben „Schließen“ auf die größte Breite schalten (WP-93).
- Im Ordner-Browser von „Neue Session“ wählt ein Klick einen Unterordner aus, und „Diesen Ordner wählen“ übernimmt ihn,
  ohne ihn zu öffnen; die Fußzeile zeigt, welcher Ordner übernommen wird (WP-94).
- „Neuer Ordner“ im Ordner-Browser legt einen Ordner im geöffneten Ordner an und wählt ihn gleich aus (WP-94).
- Wartet ein Tool-Aufruf auf die automatische Berechtigungsprüfung des Auto-Modus, zeigt seine Zeile „Berechtigung wird
  geprüft…“ statt einer Meldung „Unknown event“ (WP-95).
- Das Transkript meldet, wenn Claude auf ein Ausweichmodell wechselt, wenn Dateien einer Nachricht aus der Claude-App
  nicht ankommen und wenn eine Nachricht einer anderen Session zurückgehalten wird (WP-95).
- Nach Commit, Push, Merge oder Rebase in einer Session zeigt Parallax sofort den aktuellen Git-Branch (WP-95).
- „Shell im Ordner öffnen“ startet die Eingabeaufforderung (cmd), PowerShell oder Git Bash als eigenes Fenster im Ordner
  der Session: über das Session-Menü, einen Knopf in der Kopfzeile oder Alt+K, nur für Sessions dieses Rechners. Die
  Standard-Shell, das Fenster für Git Bash und der Ordner von Git for Windows stehen unter Einstellungen → Konsole
  (WP-97).
- Das Seitenpanel hat einen Tab „Terminal“: cmd, PowerShell oder Git Bash laufen direkt in Parallax im Ordner der
  Session, bis zu vier je Session, nur für Sessions dieses Rechners. Alt+T öffnet den Tab und führt zurück ins
  Nachrichtenfeld; die Shells laufen weiter, wenn das Panel schließt, und zeigen beim Wiederöffnen ihren Verlauf (WP-99).
- Terminal-Tabs lassen sich per Doppelklick, F2 oder Kontextmenü umbenennen und per Ziehen verschieben; Name und
  Reihenfolge gelten in allen Fenstern (WP-99).

### Geändert
- Die Oberfläche ist standardmäßig 10 % größer: Zoom 100 % sieht aus wie bisher 110 %. Wer bisher mit 110 % gearbeitet
  hat, setzt den Zoom einmal mit Strg+0 zurück (WP-96).
- Interne Hinweise von `claude`, die nur andere Programme betreffen, erscheinen nicht mehr als „Unknown event“ (WP-95).
- Gibt Parallax einen Titel an Claude Code weiter, zeigt das Transkript eine ruhige Zeile „Titel an Claude Code
  übergeben“ statt einer Nachricht, die aussieht, als hättest du sie geschrieben (WP-95).
- Rechner, die sich mit „Mehrere Rechner“ gegenseitig steuern, brauchen dafür beide diese Version (Protokollversion 6,
  WP-95).
- In einem nicht maximierten Fenster schiebt das Seitenpanel das Transkript zur Seite, statt darüber zu liegen; nur in
  sehr schmalen Fenstern liegt es noch darüber (WP-99).
- „Neue Session“ steht in der Seitenleiste vor dem Knopf für die Gruppierung (WP-99).
- Der Pfeil von „Zur ersten neuen Nachricht“ zeigt nach oben (WP-99).

### Behoben
- Die Context-Anzeige springt bei Modellen anderer Anbieter während eines Turns nicht mehr kurz auf 0 %
  (fix/context-estimate).

## [2.0.0] – 2026-11-19

### Neu
- Mehrere Rechner: Ein Parallax zeigt und steuert die Sessions anderer Rechner im selben Netz, als liefen sie lokal;
  ab Werk aus, eingeschaltet unter Einstellungen → „Mehrere Rechner“ mit den Rollen „Freigeben“ und „Andere steuern“
  (WP-75…82).
- Rechner werden per einmaligem Kopplungscode gekoppelt und sprechen nur über TLS 1.3 mit gegenseitig geprüften
  Schlüsseln; der freigebende Rechner führt ein Verbindungsprotokoll mit IP-Adressen, auch für abgelehnte Versuche
  (WP-76, WP-78).
- Entwürfe liegen im Server und erscheinen in jedem Fenster derselben Session, auch auf dem steuernden Rechner (WP-77).
- Die Seitenleiste lässt sich nach Rechner und Verzeichnis gruppieren, beide Ebenen sind einklappbar; „Neue Session“
  fragt zuerst nach dem Rechner (WP-80).
- Die Seitenleiste lässt sich am rechten Rand breiter oder schmaler ziehen (Doppelklick setzt zurück, ganz nach links
  klappt sie ein); eingeklappt zeigt die schmale Leiste „Neue Session“, „Wartet auf dich“ mit Zähler, alle Sessions,
  Einstellungen und Verbindung, und Alt+B klappt sie ein und aus (WP-90).
- Shift+Tab im Nachrichtenfeld schaltet den Berechtigungsmodus weiter wie im Claude-Code-CLI (WP-91).

### Geändert
- Parallax braucht jetzt Node.js 26.9 oder neuer (vorher 24.5): Prozesse fragt der Server nur noch selbst ab, nie mehr
  über PowerShell, und „Mehrere Rechner“ ist auf jedem Rechner verfügbar (ADR-231).
- Braucht eine neue Version ein neueres Node.js, lehnt Parallax das Update ab, bevor es das Paket lädt (ADR-232).
- Der Knopf für eine gefundene Version heißt „Jetzt aktualisieren“ statt „Update vorbereiten“; er lädt und
  installiert sie, „Neu starten“ wechselt danach (WP-89).

### Behoben
- Parallax startet für Systemabfragen kaum noch PowerShell, was Sicherheitssoftware als verdächtig melden konnte:
  Prozesse liest der Server selbst, Autostart, Protokoll-Handler und Startmenü schreibt er nur
  noch bei einer Änderung, und Virenscanner sowie Ordnerrechte fragt er nicht mehr ab (fix/quiet-system-calls).

### Hinweise zum Update
- Vor dem Update Node.js auf 26.9 oder neuer aktualisieren; 1.0.x lädt das Paket sonst und lehnt es danach mit der
  nötigen und der installierten Version ab (ADR-231).

## [1.0.1] – 2026-11-18

### Sicherheit
- Zwei bekannte Lücken (mittel) in `glob` und `minimatch`, die `@fastify/static` mitbringt, sind geschlossen:
  `@fastify/static` 10.1.9 mit `glob` 14.0.3 und `minimatch` 11.0.4 (DEPS-2026-11 §8).

## [1.0.0] – 2026-11-18

Erstes Release. Parallax steuert viele parallele Claude-Code-Sessions in einem Fenster: Status, Kontext, Chat,
Entscheidungen ohne Modaldialog, Dateien und Pläne, Aufgaben und Subagenten.

### Neu
- Parallax steht unter der MIT-Lizenz; die README beschreibt unter „Rechtliches“ das Verhältnis zu Anthropic und
  Claude Code (WP-84).
- Releases erscheinen auf GitHub als signiertes Paket (`parallax-<version>-win.zip`, Ed25519) mit den Notizen aus
  diesem Changelog (WP-85).
- Parallax lässt sich ohne git, pnpm und Build installieren: Paket entpacken und `install.cmd` starten; es landet je
  Nutzer in `%LOCALAPPDATA%\Programs\Parallax` mit Eintrag im Startmenü, ein neueres Paket aktualisiert auf demselben
  Weg (WP-86).
- Vor dem ersten Start einer neuen Version sichert Parallax seine Daten; die drei jüngsten Sicherungen bleiben (WP-86).
- `parallax.cmd --use <version>` schaltet auf eine andere installierte Version um, `--uninstall` entfernt die
  Installation samt Startmenü, Autostart und Link-Handler; die Daten bleiben (WP-86).
- Parallax sucht beim Start und alle 12 Stunden nach einer neuen Version, lädt sie auf Knopfdruck, prüft Signatur und
  Dateien und wechselt mit einem Neustart; die Sessions lassen sich danach fortsetzen (WP-87…89).
- „Aus Datei installieren…“ übernimmt ein heruntergeladenes Release-Paket ohne Zugriff auf GitHub (WP-87…89).
- „Zurück zu <Version>“ wechselt auf die vorige Version, bei Bedarf mit der Sicherung der Daten; startet eine neue
  Version nicht sauber, kehrt Parallax von selbst zur alten zurück (WP-87…89).
- „Was ist neu“ zeigt die Änderungen einer Version aus dem signierten Changelog, dazu Lizenz und Hinweise zu
  Drittkomponenten (WP-88).
- Updates holen das Agent SDK aus der npm-Konfiguration oder aus einer unter Einstellungen → „Updates“ eingetragenen
  Registry, z. B. einem Firmen-Mirror (WP-89).

### Geändert
- Ein Klon lässt Autostart, Link-Handler und Startmenü einer Installation in Ruhe, statt sie auf sich umzubiegen
  (WP-86).
- Startet der Server neu, wartet das Fenster bis zu fünf Minuten und verbindet sich wieder, statt „Server beendet“ zu
  zeigen (WP-88).

### Behoben
- Aus PowerShell 7 gestartet, scheitern die Prüfung der Ordnerrechte von `PARALLAX_HOME`, die Prozessabfragen und die
  Virenscanner-Anzeige in `pnpm preflight` nicht mehr (WP-85).

### Sicherheit
- Bekannte Lücken (mittel/niedrig) in Abhängigkeiten des Agent SDK sind geschlossen: `hono` 4.13.16 und
  `@hono/node-server` 2.1.6 (DEPS-2026-11 §6).

### Hinweise zum Update
- Parallax braucht jetzt Node.js 24.5 oder neuer (vorher 22) (WP-85).
