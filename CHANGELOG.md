# Changelog

Alle nennenswerten Änderungen an Parallax. Versionen nach SemVer, neueste zuerst. Aufbau nach „Keep a Changelog“;
Pflege und Release-Ablauf stehen in `docs/wp/WP-83.md` §4.

## [Unveröffentlicht]

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
