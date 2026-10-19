# Code-Review Phase 2 – Fix-Runde, Paket S2 System/Upload

- **Datum:** 19.10.2026, Branch `fix/cr2-s2` (Worktree `.worktrees/cr2-s2`, Basis `main` `d8648ab`).
- **Funde:** CR2-01, CR2-03, CR2-06, CR2-07, CR2-08 (`docs/wp/CODE-REVIEW-2.md`).
- **Vorgehen:** je Fund erst ein Test gegen den alten Code (rot), dann der Fix (grün); die Tests bleiben
  als Regression (Testname „CR2-0x: …“). Kein Port, kein Contract, kein `src/shared/**` geändert;
  nur bestehende Fehlercodes. Registry und Autostart nur über Fakes; kein Live-`claude`, keine
  Desktop-Bedienung.

## Ergebnis je Fund

| Nr. | Reproduziert | Fix | Regressionstest | Commit |
|---|---|---|---|---|
| CR2-01 | **ja**, 4 Tests rot: Fake-`reg.exe` mit Abfrage-Timeout, Startfehler bzw. Exit 5 → drei `reg add`; Schlüssel `parallax` (fremd, `URL:Other App`, nur `shell\view`) ohne `shell\open\command` → überschrieben. **Teilfall „ohne Standardwert (DelegateExecute)“ nicht reproduzierbar:** das echte `reg.exe` meldet einen vorhandenen Schlüssel ohne Standardwert mit Exit 0 und `(Standard) REG_SZ (Wert nicht festgelegt)` (einmal read-only per `reg query` geprüft) – das wurde schon als fremd erkannt; jetzt als Test festgehalten. | `system/protocol.ts`: neuer `regKeyReader(run)` (`reg query <key> /ve`) wertet den Exit-Code aus: 0 = vorhanden, 1 = fehlt, alles andere (Timeout, Startfehler, anderer Exit) = fehlgeschlagen → `PROTOCOL_HANDLER_FAILED {reason: 'registry query: …'}`, nichts geschrieben. Fehlt `shell\open\command`, wird der Schlüssel `parallax` selbst geprüft: vorhanden = fremd (`foreign`). Der eigene Befehl wird jetzt **zuerst** geschrieben (ein unterbrochenes Registrieren bleibt erkennbar eigen, sonst wäre es danach „fremd“). Abmelden: Abfragefehler = Fehler (Warnung, nächster Abgleich versucht es erneut) statt still `ok`. `index.ts` verdrahtet `read: regKeyReader(run)` (R6: ohne `runFile`-Default). | `system/index.test.ts` „CR2-01: a failed registry query (timeout/spawn/exit) …“, „CR2-01: an existing parallax key without a recognizable own command is foreign …“ (Fake-`reg.exe` modelliert jetzt Schlüssel mit Unterschlüsseln und „(value not set)“); `protocol.test.ts` „CR2-01: …“ (Abfragefehler, Schlüssel ohne Befehl, DelegateExecute) + `regKeyReader` (Exit 0/1/5/null, Timeout, Startfehler); `guard.test.ts` erwartet den Abfragefehler | `0832ed4`, Formatierung `974523a` |
| CR2-03 | **ja**, 3 Tests rot: `createAutostartShortcut` gab den Marker nicht mit, das Skript prüfte nur beim Entfernen, eine fremde Verknüpfung (Ausgabe `foreign`) wurde nicht als Ablehnung erkannt. | `system/autostart.ts`: das konstante Skript liest eine vorhandene `Parallax.lnk` **vor beiden Aktionen**; ohne `launcher\main.ts` in den Argumenten → `foreign`, nichts gespeichert/gelöscht. Anlegen übergibt `PARALLAX_LNK_MARKER` und meldet `foreign` als `{ok: false, reason: 'foreign'}` → `AUTOSTART_FAILED {reason: 'foreign'}`; Entfernen meldet weiter `ok` (R4-11). **UI:** `features/preferences/components/HostWarnings.tsx` zeigt bei `reason: 'foreign'` einen Hinweis (`preferences.server.autostartForeign`, `preferences.notifications.openOnClickForeign`, en + de) – vorher nur „Autostart could not be set up.“ ohne Ursache; Playground-Demo „server-warnings“ zeigt ihn. | `autostart.test.ts` „CR2-03: creating passes the marker and refuses a foreign shortcut …“, „CR2-03: the script checks an existing shortcut before either action …“; `index.test.ts` „CR2-03: a foreign Parallax.lnk is never replaced …“; `SettingsPage.test.tsx` „CR2-03: …“ (Hinweis bei `foreign`, keiner bei anderem Grund). **Zusätzlich einmal manuell** das echte Skript per `runFile` gegen einen **Temp-Ordner** (nicht den Autostart-Ordner): eigene anlegen/erneuern/entfernen `ok`; fremde anlegen, dann eigene darüber → `{ok:false, reason:'foreign'}`, Datei unverändert; Entfernen → `ok`, fremde Datei bleibt. | `f140cc3` |
| CR2-06 | **ja**, Test rot: „expected 26 to be less than or equal to 2“ (alle 26 `stat` gleichzeitig). | `host/fsCommands.ts`: höchstens `DRIVE_PROBE_LIMIT` (2) Laufwerks-`stat`s gleichzeitig, in Laufwerksreihenfolge; ein Platz wird erst frei, wenn sein `stat` wirklich endet – auch nach dem Timeout (zählt über Aufrufe hinweg). Weiter höchstens ein `stat` je Laufwerk. Damit ein lokales Laufwerk hinter zwei hängenden nicht verschwindet (der zweite Teil des Befunds), behält eine Probe, die beim Timeout noch auf einen Platz **wartet**, die Antwort ihres letzten beendeten `stat`; ein `stat`, das läuft und zu lange braucht, bleibt „langsam“ (entfällt). | `fsCommands.test.ts` „CR2-06: at most DRIVE_PROBE_LIMIT drive stats at once …“ (Fake-`stat` mit Zähler, zwei hängende Laufwerke, zweite Liste ohne weitere `stat`s und mit `C:` aus der letzten Antwort, nach dem Lösen läuft die Warteschlange ab, `Z:` erscheint) | `ab51d4e` |
| CR2-07 | **ja**, 5 Tests rot – und eine im Review nicht genannte zweite Ausprägung: **gleicher Prozess** → Upload liefert die alte Ref (`application/octet-stream`), `resolveAttachments` lehnt mit `UNSUPPORTED_MEDIA_TYPE` ab; **nach einem Neustart** liefert der Upload zwar eine neue Ref, die Meta-Datei bleibt aber alt (`write` schrieb nur bei fehlender Meta) → der Prompt scheitert trotzdem. | `store/blobs.ts` (ohne Port-Änderung): `put` ersetzt die gespeicherte Meta eines Inhalts nur durch eine bessere (`replacesMeta`): den per `sniffImageType` bestätigten Bildtyp statt eines anderen gespeicherten Typs, oder – als Upload, das einzige `put` mit Pixelgröße (ADR-103) – andere Namen/Größe dieses Typs (letzter Upload gewinnt). Ein `put` ohne beides (Normalizer) ersetzt nie; sonst gewinnt weiter die erste Meta. Dieselbe Regel gilt in `write` gegen die Meta-Datei (auch nach Neustart; eine behaltene Meta beantwortet spätere `put`s des Prozesses); Schreibvorgänge eines Inhalts laufen nacheinander (Kette je `blobId`); eine ungültige Meta-Datei wird ersetzt, eine unlesbare (nicht ENOENT) bleibt. | `upload.test.ts` „CR2-07: bytes the normalizer stored as application/octet-stream …“ (mit echtem `resolveAttachments`), „CR2-07: also after a restart …“; `blobs.test.ts` „CR2-07: which meta of a content wins“ (Typkorrektur, letzter Upload, Normalizer ersetzt nie, Neustart) | `879faeb` |
| CR2-08 | **ja**, 3 Tests rot (415 für JPEG als PNG, PNG als GIF, WebP als JPEG). | Weg **(a)**: `http/app.ts` speichert den per Magic Bytes erkannten Typ, solange er ein Bildtyp der API ist; ohne erkannten Bildtyp (HTML, SVG, leer) bleibt es bei 415 (R7). Der Client bleibt unverändert (Kommentar in `composer/lib/images.ts`). | `upload.test.ts` „CR2-08: … is stored with the type of its magic bytes (ADR-134)“ (Antwort **und** gespeicherte Ref); „415 when the magic bytes show no image type“ (HTML, SVG, leer) | `b9fea1d` |

## Entscheidungen

1. **CR2-08 Weg (a) statt (b).** Die strikte Ablehnung steht nicht als Entscheidung in einem ADR:
   ADR-103 sagt nur „Magic-Byte-Prüfung“, WP-33 hat „passend zum Content-Type, sonst 415“
   festgelegt, Ziel war R7 („Typ-Spoofing“). Dieses Ziel bleibt erhalten, weil der gespeicherte und
   ausgelieferte Typ immer aus den Bytes stammt und nur API-Bildtypen angenommen werden. Für (a)
   spricht: Die API verlangt den zu den Bytes passenden `media_type`, der Server ist dafür ohnehin
   die Autorität, ein Ort, keine zweite Erkennung im Web (Web darf Server-Code nicht importieren).
   (b) hätte die Erkennung im Client dupliziert. Bei Neukodierung gingen JPEG-Qualität und
   GIF-Animation verloren. Grenze: Der Dateiname behält die Endung des Nutzers (`photo.png` als
   `image/jpeg`).
2. **CR2-01: `regKeyReader` liegt in `system/protocol.ts`**, nicht in `lib/registry.ts` (nicht in
   den Pfaden dieses Pakets). `lib/registry.ts` liefert bei jedem Fehler `null` und kann „fehlt“
   nicht von „fehlgeschlagen“ unterscheiden. Bekannte Grenze: `reg.exe` meldet auch „Zugriff
   verweigert“ mit Exit 1. Das gilt dann als „fehlt“, aber der folgende `reg add` scheitert in dem
   Fall ebenso (Schreiben braucht mehr Rechte als Lesen), es wird also nichts überschrieben. Ein
   halb geschriebener Schlüssel aus der alten Schreibreihenfolge (Abbruch vor dem Befehl, also ohne
   `shell\open\command`) gilt jetzt als fremd. Das ist unwahrscheinlich; die Warnung bleibt, bis
   der Nutzer den Schlüssel entfernt.
3. **CR2-06: Limit 2 plus „letzte Antwort beim Warten“.** Das Limit allein hätte lokale Laufwerke
   aus der Liste genommen, solange zwei Netzlaufwerke hängen, und damit die zweite Hälfte des
   Befunds nicht behoben. Grenze: Ein nie gesehenes Laufwerk hinter zwei hängenden fehlt, bis es
   geprüft ist. Ein inzwischen entferntes Laufwerk kann in dieser Zeit noch erscheinen; Öffnen
   liefert dann `CWD_NOT_FOUND`.

Weitere kleine Entscheidungen sind in der Tabelle beschrieben: Schreibreihenfolge des Protokoll-Handlers, Abmelden bei Abfragefehler, UI-Hinweis bei `foreign`.

## Schnittstellen / Doku für den Koordinator

- **Kein Port, kein Contract geändert.** `ProtocolRegistryDeps` (nicht in `ports.ts`) hat jetzt
  `read: RegKeyReader` statt `query: RegQuery`. Einziger Nutzer ist `system/index.ts`.
- **`params.reason: 'foreign'`** stand für `PROTOCOL_HANDLER_FAILED` schon auf dem Draht und ist neu
  für `AUTOSTART_FAILED`. Die UI wertet den Wert jetzt aus (`HostWarnings`), sonst nirgends.
  Vorschlag: In `src/shared/errors.ts` bei beiden Codes kommentieren: „`params.reason`; `'foreign'`
  = fremde `Parallax.lnk` bzw. fremder `parallax:`-Handler, nie ersetzt“. Kein Schema-Eingriff nötig.
- **`docs/architecture.md`** (Koordinator) nachziehen: Z. 283 (Upload „passend zum Content-Type
  (sonst 415)“ → „erkannter Bildtyp gilt, ohne Bildtyp 415“; `blobs.put` „bessere Meta ersetzt“),
  Z. 284 (Ordner-Browser: „höchstens zwei Laufwerks-`stat`s gleichzeitig, wartende Probe behält die
  letzte Antwort“), Z. 827 (Upload-Zeile).
- `src/server/sessions/testing/memoryStores.ts` (S1/Koordinator) behält als Test-Double „erste Meta
  gewinnt“. Für bestehende Tests ist das unkritisch und nur bei Bedarf angleichen.
- READMEs aktualisiert (nur Ordner dieses Pakets): `src/server/{system,host,http,store}/README.md`,
  `src/web/features/preferences/README.md`.

## ADR-Vorschläge (Text für `docs/decisions.md`)

```markdown
## ADR-133 – Windows-Integration: fremde Einträge nie ersetzen, fehlgeschlagene Abfrage heißt nicht „frei“
- **Datum/WP:** 19.10.2026, Code-Review Phase 2 (CR2-01, CR2-03). Ergänzt ADR-109, ADR-110 und R4-11.
- **Kontext:** Der Protokoll-Handler las jeden `reg.exe`-Fehler (Timeout, Startfehler, Exit ≠ 0) als
  „kein Handler“ und überschrieb dann `HKCU\Software\Classes\parallax` per `reg add /f`, auch den
  Schlüssel einer anderen App ohne `shell\open\command`. Die Autostart-Verknüpfung ließ eine fremde
  `Parallax.lnk` beim Entfernen stehen (R4-11), ersetzte sie aber beim Anlegen still; das spätere
  Ausschalten löschte dann den Ersatz, und die Verknüpfung des Nutzers war weg.
- **Entscheidung:** (1) Registry-Abfragen des Protokoll-Handlers werten den Exit-Code von
  `reg query <key> /ve` aus: 0 = vorhanden (auch ohne Standardwert), 1 = fehlt, sonst
  fehlgeschlagen. Eine fehlgeschlagene Abfrage schreibt und löscht nichts und wird zur Warnung
  `PROTOCOL_HANDLER_FAILED {reason}`. (2) Fremd ist ein `parallax`-Schlüssel, dessen
  `shell\open\command` `launcher\main.ts` nicht enthält oder der keinen solchen Befehl hat. Der eigene
  Befehl wird zuerst geschrieben. (3) Das Autostart-Skript liest eine vorhandene `Parallax.lnk` vor
  **beiden** Aktionen. Ohne Marker bleibt sie: Entfernen meldet `ok`, Anlegen lehnt mit
  `AUTOSTART_FAILED {reason: 'foreign'}` ab. (4) Die Einstellungen erklären `reason: 'foreign'` mit
  einem Hinweis, was zu tun ist.
- **Folgen:** Ein fremder Eintrag oder ein Abfragefehler bleibt eine Warnung. Jeder weitere Abgleich
  versucht es erneut, bis der Nutzer den fremden Eintrag umbenennt oder entfernt. Umsetzung:
  `system/protocol.ts` (`regKeyReader`), `system/autostart.ts`, `features/preferences/components/HostWarnings.tsx`.

## ADR-134 – Bild-Upload: der erkannte Bildtyp gilt, die Meta des Uploads gewinnt
- **Datum/WP:** 19.10.2026, Code-Review Phase 2 (CR2-07, CR2-08). Ergänzt ADR-103.
- **Kontext:** Der Browser leitet `file.type` aus der Endung ab. Ein umbenanntes Bild (`photo.png`,
  das ein JPEG ist) scheiterte mit 415, obwohl die Magic Bytes einen gültigen Bildtyp zeigen. Der
  inhaltsadressierte BlobStore behielt die erste Meta eines Inhalts. Lagen die Bytes schon mit
  anderem Typ im Store (Normalizer, z. B. `application/octet-stream`), lieferte der Upload die alte
  Ref, oder nach einem Neustart blieb die alte Meta-Datei. Der Prompt scheiterte dann mit
  `UNSUPPORTED_MEDIA_TYPE`.
- **Entscheidung:** (1) Der Upload speichert den per Magic Bytes erkannten Typ, solange er ein Bildtyp
  der API ist. Ohne erkannten Bildtyp bleibt es bei 415 (R7: der gespeicherte und ausgelieferte Typ
  stammt immer aus den Bytes). (2) `BlobStore.put` ersetzt die Meta eines Inhalts nur durch eine
  bessere: den bestätigten Bildtyp statt eines anderen gespeicherten Typs, oder als Upload (das
  einzige `put` mit Pixelgröße) einen anderen Namen bzw. eine andere Größe dieses Typs, dann gewinnt
  der letzte Upload. Ein `put` ohne beides (Normalizer) ersetzt nie. Die Regel gilt im Speicher und
  gegen die Meta-Datei; Schreibvorgänge eines Inhalts laufen nacheinander.
- **Folgen:** Kein Port geändert. Transkript-Items behalten ihre eingebettete Ref. Nur `GET
  /api/blob` und spätere Refs sehen die neue Meta. Der Dateiname behält die Endung des Nutzers. Ein
  Upload ohne `width`/`height` korrigiert nur den Typ.

## ADR-135 – Ordner-Browser: höchstens zwei Laufwerksproben, wartende behalten die letzte Antwort
- **Datum/WP:** 19.10.2026, Code-Review Phase 2 (CR2-06). Ergänzt ADR-119 und R8.
- **Kontext:** Die Wurzelliste startete 26 `stat('X:\')` gleichzeitig auf dem libuv-Pool (vier
  Threads). Hängende Netzlaufwerke (≈ 20 s) belegten den Pool und blockierten jeden anderen
  fs-Zugriff des Servers. Echte Laufwerke fielen nach 1,5 s aus der Liste.
- **Entscheidung:** Höchstens zwei Laufwerks-`stat`s gleichzeitig, in Laufwerksreihenfolge, je
  Laufwerk höchstens eines. Ein Platz wird erst frei, wenn sein `stat` wirklich endet, auch nach
  dem Timeout und über Aufrufe hinweg. Eine Probe, die beim Timeout (1,5 s ab der Anfrage) noch auf
  einen Platz wartet, behält die Antwort ihres letzten beendeten `stat`. Ein laufendes `stat`, das
  zu lange braucht, gilt als langsam (entfällt).
- **Folgen:** Mindestens zwei Pool-Threads bleiben für den Server frei. Ein nie gesehenes Laufwerk
  hinter zwei hängenden fehlt, bis es geprüft ist. Ein entferntes Laufwerk kann in dieser Zeit noch
  erscheinen (Öffnen → `CWD_NOT_FOUND`).
```

## Checks

- `pnpm check` im Worktree grün: typecheck (`tsc -b`) ok, lint (`eslint . --max-warnings=0`) ok,
  `vitest run` **215 Testdateien, 3782 Tests** grün.
- `pnpm build` grün (`dist/web` + `dist/server.js`).
- Prettier: alle geänderten Dateien formatiert. Fremde, schon vorher unformatierte Stellen in
  `SettingsPage.test.tsx` sind unverändert.
- Manuell (einmalig, nicht im Repo): read-only `reg query` (fehlender Schlüssel → Exit 1;
  vorhandener ohne Standardwert → Exit 0, „(Wert nicht festgelegt)“); das echte
  `AUTOSTART_SCRIPT` gegen einen Temp-Ordner (siehe CR2-03). Keine Hintergrundprozesse übrig.

## Follow-ups

- `regKeyReader` nach `src/server/lib/registry.ts` verschieben (z. B. `regQueryKey` mit Ergebnis
  vorhanden/fehlt/fehlgeschlagen), wenn das Paket des Ordners wieder offen ist.
- Live-Abnahme bei Gelegenheit (WP-41-Stil, nur mit Freigabe): fremder `parallax:`-Schlüssel und
  fremde `Parallax.lnk` im echten Profil; getrenntes Netzlaufwerk im Ordner-Browser.
