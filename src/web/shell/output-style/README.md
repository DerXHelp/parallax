# src/web/shell/output-style – Ausgabestil je Projekt (WP-70)

Der Ausgabestil gilt für das Projekt (`<cwd>\.claude\settings.local.json`, Schlüssel `outputStyle`) und
damit für alle Sessions darin, ab ihrem nächsten Turn. Der Server schreibt ihn im Prozess der Session
(`session.setOutputStyle` → `updateSettings('localSettings', {outputStyle})`, eine schlafende Session
startet ohne Turn); die verfügbaren Stile meldet das CLI (`detail.availableOutputStyles`), den
aktuellen `summary.outputStyle`.

| Datei | Inhalt |
| --- | --- |
| `OutputStylePicker.tsx` | Liste der Stile als Knöpfe (`aria-pressed` = aktuell; keine Radiogruppe – Pfeiltasten schreiben nie), Klick → `session.setOutputStyle`; Fehler als `Alert` (`role="alert"`); archiviert/extern: nur lesen mit Grund; ohne Liste bei schlafender Session „Session starten“ (`session.resume`), bei laufender „meldet keine Ausgabestile“. `heading`: eingebettet im Session-Info-Reiter „Status“ (eigene Überschrift und Hinweis, ohne eigenes „Session starten“ – der Reiter hat eins) |
| `OutputStyleDialog.tsx` | Lazy-Chunk (NavigationLayer, Shell-Anfrage `outputStyle` aus dem Kopfzeilen-„…“-Menü, Aktion `outputStyle`): Titel, Hinweis „gilt für alle Sessions in diesem Projekt (`.claude\settings.local.json`)“, Picker |
| `i18n/` | Lazy-Namensraum (`useStyleT`, ADR-183; in `LAZY_NAMESPACES`) – kommt mit Dialog bzw. Session-Info, nie mit dem Start-Chunk |
| `output-style.test.tsx` | Picker (Liste, Wechsel, Fehler, nur lesen, Start), Dialog über die Anfrage (Deutsch), Menüeinträge (`outputStyle` nur Kopfzeile, aus für archiviert/extern; `signIn` nur bei `REMOTE_CONTROL_AUTH`), Lazy-Namensraum |
