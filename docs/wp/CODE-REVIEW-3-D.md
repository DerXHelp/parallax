# Fix-Runde CR3 – Paket D (Datei-Dienst/HTTP)

- **Datum:** 12.11.2026
- **Branch/Worktree:** `fix/cr3-d` in `.worktrees/cr3-d`, Basis `feature/phase-3` @ `8b54b9c`
- **Auftrag:** `docs/wp/CODE-REVIEW-3.md`, Funde CR3-03, CR3-04, CR3-05 und CR3-10
- **Geänderte Pfade:**
  - `src/server/files/**` und `src/server/http/**` (Code, Tests, READMEs; beide Ordner gehören nur WP-53)
  - dieses Dokument
- **Nicht geändert:** Contracts, Ports, `src/shared/**`, `src/server/lib/**`, Abhängigkeiten.
- **Fehlercodes:** nur bestehende.
- **Ressourcen (ADR-154):**
  - Gelaufen sind nur gezielte `vitest run <eigene Pfade> --maxWorkers=2`, `eslint`/`prettier` auf
    eigenen Pfaden und ein `pnpm typecheck`.
  - Alle Läufe mit Priorität „niedriger als normal“.

## Ergebnis je Fund

| Nr. | Reproduziert (Beleg: Test gegen den alten Code) | Fix | Regressionstest | Commit |
|---|---|---|---|---|
| CR3-03 | **ja.** Sechs Tests rot:<br>• octet-stream mit PNG/JPEG/GIF/WebP wurde als `image/*` gespeichert;<br>• ein 5-MB-PNG als octet-stream bekam 413 statt 200 (Bild-Grenze 3,75 MB statt Datei-Grenze 10 MB). | `uploadKind` (`http/app.ts`) macht nur aus einem **als Bild deklarierten** Upload ein Bild.<br>• octet-stream bleibt Datei, auch mit Bild-Bytes: Datei-Grenze, `name` Pflicht, ohne Pixelgröße; die Engine kopiert sie in den Anhangordner.<br>• PDF per Magic-Bytes unverändert. | `http/upload.test.ts`:<br>• „CR3-03: an image sent as a file …“ (5 MB, 9000 px, `resolveAttachments` → `files` statt `blocks`, ohne `name` → 400);<br>• Tabelle octet-stream je Bildtyp;<br>• Grenzen je Typ. | `84f3eed` |
| CR3-04 | **ja.** Bei drei Dateien meldete `statAllowed` `truncated: false`, obwohl `readTextContent` kürzte:<br>• windows-1252, 2 097 100 B (UTF-8 4,17 MB);<br>• UTF-16LE CJK, 1,5 MB (UTF-8 2,28 MB);<br>• UTF-8 mit ungültigen Bytes nach dem Kopf. | `stat.ts`: `truncated` = Quelle > `fileTextBytes` **oder** UTF-8-Form > `fileTextBytes`.<br>• Gelesen wird nur, wenn die Obergrenze offen lässt, ob die Grenze überschritten wird.<br>• Ergebnis je Dateiversion im LRU-Cache des Dienstes.<br>• `open()` (HTTP) überspringt die Prüfung.<br>Ansatz unten. | `files/stat.test.ts`:<br>• „CR3-04: truncated matches the cut …“ (vier Fälle; Vergleich mit dem tatsächlich gesendeten Text);<br>• „CR3-04: the exact check reads only …“ (Lesezugriffe gezählt, Cache, `skip`). | `1f05a40` |
| CR3-05 | **ja.**<br>• Datei schrumpft (400 → 250 B): `bytes`/`Content-Length` 400, Körper 250 B.<br>• Datei wächst (400 → 600 B): Länge passt, der Körper ist aber nur der Anfang der neuen Datei (kaputtes Bild bis zur nächsten Änderung).<br>• Belegt per Unit-Test und Ende-zu-Ende über `app.inject` mit dem echten Dienst und echter Datei. | Bild/PDF werden über **ein** Handle ganz gelesen (`FileFs.readWhole`, `files/fileFs.ts`):<br>• Größe vom Handle, danach bis zum Dateiende;<br>• `null` über `fileBinaryBytes` → `PAYLOAD_TOO_LARGE`;<br>• gesendet als Puffer, `bytes` = genaue Länge.<br>Ansatz unten. | `files/content.test.ts`:<br>• „CR3-05: the file shrank/grew …“;<br>• „… grew over fileBinaryBytes …“.<br>`http/file.test.ts`: „CR3-05: an image replaced by a smaller/larger one …“.<br>`files/fileFs.test.ts`: `readWholeFile`. | `9a9b875` |
| CR3-10 | **ja.** Ein Seitenleser zählt bei jedem Lesezugriff die ausgegebenen, noch nicht angesehenen Items: `[0, 2000, 4000]`, d. h. alle Seiten wurden gehalten, bevor das erste Item verarbeitet war. | `sessionIndex.ts`:<br>• `visitNewestFirst` verarbeitet jede Seite (neueste zuerst), bevor die nächste gelesen wird;<br>• Unterhaltungen laufen neueste zuerst, der ganze Backfill läuft also rückwärts in der Zeit;<br>• Zählregel angepasst (unten). | `files/sessionIndex.test.ts`:<br>• „CR3-10: the backfill handles each page before …“ (jetzt `[0, 0, 0]`);<br>• „CR3-10: page by page back in time …“ (Ops-Reihenfolge, `count`, `firstAt`/`lastAt`, `lastToolUseId`, Unterhaltung über Seiten- und Unterhaltungsgrenzen). | `582f0a1` |

### CR3-03 – Ansatz
- **Ursache:** Der Composer schickt `application/octet-stream` nur für Dateien, die er **nicht** als Bild
  erkennt. Nur ein deklariertes Bild hat er skaliert (`prepareImage`).
- **Folge:** Ein octet-stream-Upload darf deshalb nie zum Bild-Block werden. Sonst gilt die
  Bild-Grenze ohne Skalierung, und eine 9000-px-Datei lässt die API scheitern.
- **Fix serverseitig, im Rahmen des Contracts:**
  - `UPLOAD_MEDIA_TYPES` bleibt.
  - Für octet-stream galt schon „`name` Pflicht“.
  - Die Antwort trägt wie bisher den gespeicherten Typ.
- **Client:** Es ist kein Client-Teil nötig. `kindOfRef` im Composer macht aus `application/octet-stream`
  einen „file“-Chip. Die Engine (`checkAttachments`) kopiert die Datei, und Claude liest sie mit `Read`.
- **PDFs** bleiben bei octet-stream per Magic-Bytes ein PDF, weil
  - sie keine Vorbereitung im Client brauchen,
  - Datei- und PDF-Grenze gleich sind (10 MB),
  - ADR-146 das so festlegt und der Client das Ergebnis übernimmt.

### CR3-04 – Ansatz und Kosten
- **Exaktheit:**
  - `decodedUtf8Size` dekodiert genau wie `readTextContent` (`decodeText`, dann UTF-8-Länge).
  - Gültiges UTF-8 wird ohne String gezählt (`isUtf8`, nativ): Länge minus BOM.
- **Obergrenze statt Lesen** (`utf8SizeBound`):
  - windows-1252: höchstens 3 B je Byte;
  - UTF-16: höchstens 3 B je 2-Byte-Einheit;
  - UTF-8: höchstens 3 B je Byte außerhalb des Kopfes, den die Erkennung geprüft hat (ohne BOM).
- **Wann gelesen wird:** Liegt die Grenze darunter, gibt es keinen zusätzlichen Lesezugriff. Gelesen wird
  also nur bei
  - windows-1252 über ca. 699 kB,
  - UTF-16 über ca. 1,4 MB,
  - UTF-8 über ca. 743 kB,
  - und nur bis 2 MiB; darüber gilt `truncated` ohnehin.
- **Cache:**
  - Schlüssel: physischer Pfad, Größe, `mtimeMs`, Kodierung; LRU mit 256 Einträgen je Dienst.
  - Ein unverändert gepollter Viewer (alle 2 s, ADR-143) liest die Datei also einmal.
  - Ändert sie sich, liest der Viewer den Inhalt ohnehin neu. Der Zusatz liegt damit höchstens bei
    einem Lesen ≤ 2 MiB je Dateiversion, und das mit dem 3-s-Wächter.
- **`statMany`:** Höchstens 8 parallel, je Pfad einmal je Version.
- **HTTP:** `GET /api/file` braucht das Flag nicht und überspringt die Prüfung (`'skip'`). So wird die
  Datei nicht doppelt gelesen.

### CR3-05 – Ansatz
- **Gewählt: „gepuffert bis zur bestehenden Grenze“, über ein Handle.**
  - Die Länge ist die der gelesenen Bytes und weicht damit nie ab.
  - Der Inhalt ist die Datei zum Lesezeitpunkt, nicht eine alte Länge der neuen Datei.
  - Damit ist auch der Fall „gewachsen“ gelöst, den eine bloße Längenkorrektur übersehen hätte: Nach
    dem Ersetzen hält der Viewer den neuen `mtime` sonst für geladen und zeigt bis zur nächsten
    Änderung ein abgeschnittenes Bild.
- **Verworfen:**
  - **Länge vom Handle + Stream:** Eine Kürzung an Ort und Stelle (`writeFile` kürzt erst) während des
    Streamens bricht die Antwort weiterhin ab.
  - **Ohne feste Länge (chunked):** Der Port `FileContent.bytes` verspricht „Bytes that will be sent“.
    Die Route könnte Text und Stream nicht unterscheiden. Bei gewachsener Datei bleibt das Bild
    abgeschnitten.
- **Preis:**
  - Bis `fileBinaryBytes` (50 MB) Speicher je gleichzeitiger Bild/PDF-Antwort.
  - Der Viewer lädt nur bei einer Änderung (`no-store`), Bilder sind meist klein.
- **Timeout:** `readWhole` läuft wie zuvor der Stream ohne 3-s-Wächter. `stat` und Kopf der Datei haben
  gerade rechtzeitig geantwortet, und eine große PDF auf einem langsamen Laufwerk braucht länger als 3 s.

### CR3-10 – Zählung
- **Alte Regel:** `count`, `lastAt` und Co. bewegten sich nur bei einem **neueren** `at`. Das setzt eine
  Verarbeitung vorwärts in der Zeit voraus.
- **Neue Regel:**
  - Es zählt nur ein Datensatz **außerhalb** der bekannten Zeitspanne `[firstAt, lastAt]`. Live erweitert
    er sie nach vorn, der Backfill nach hinten.
  - Ein Datensatz innerhalb der Spanne kann ein nach einem Neustart erneut veröffentlichter Tool-Call
    sein (Dedupe-Schlüssel verloren) und zählt nicht; das war schon vorher so.
  - Die Op eines früheren Datensatzes rückt nach vorn. `ops` bleibt so in der Reihenfolge des ersten
    Auftretens (Contract-Kommentar „first-seen order“).
- **Ergebnis bei zeitlich geordneten Transkripten:** Gleich wie vorher. Das belegen die bestehenden
  Tests (4500 Items, zwei Unterhaltungen, Neustart) und der neue Test über Seitengrenzen.
- **Nebeneffekt (Verbesserung):** Eine `files.json` mit `backfilled: false` und Live-Einträgen zählt beim
  Backfill jetzt auch die älteren Tool-Calls; vorher wurden sie verschluckt.

## Checks (gezielt; den vollen Check macht der Koordinator)

| Prüfung | Ergebnis |
|---|---|
| `pnpm exec vitest run src/server/files src/server/http src/server/app/compose.test.ts --maxWorkers=2` | grün, 15 Dateien, 354 Tests |
| `pnpm exec eslint src/server/files src/server/http --max-warnings=0` | grün |
| `pnpm exec prettier` auf allen geänderten Dateien | formatiert |
| `pnpm typecheck` (einmal) | grün |
| `pnpm check`, `pnpm build`, `pnpm e2e` | **nicht gelaufen** (ADR-154, Koordinator) |

## ADR-Vorschlag

### ADR-157 – Datei-Dienst: Upload-Typ nach Absicht, exakte Kürzungsanzeige, Inhalte mit genauer Länge, Backfill seitenweise
- **Datum/WP:** 12.11.2026, Fix-Runde CR3 Paket D. Vorschlag; ergänzt ADR-134, ADR-142, ADR-145 und
  ADR-146.
- **Kontext:** Das `/code-review` Phase 3 fand vier Fehler (CR3-03, CR3-04, CR3-05, CR3-10):
  - ein octet-stream-Upload mit Bild-Bytes wurde zum unskalierten Bild mit Bild-Grenze;
  - `truncated` übersah die Kürzung von UTF-16- und windows-1252-Texten;
  - `Content-Length` kam aus einer veralteten `stat`-Größe;
  - der Index-Backfill hielt ganze Unterhaltungen im Speicher.
- **Entscheidung:**
  1. **Upload:**
     - Ein Bild entsteht nur aus einem als Bild deklarierten Upload; nur diesen hat der Client
       vorbereitet.
     - `application/octet-stream` ist immer eine Datei, auch mit Bild-Bytes: `fileAttachmentBytes`,
       `name` Pflicht, Anhangordner.
     - `%PDF-` bleibt bei `application/pdf` und octet-stream ein PDF (ADR-146).
  2. **`FileInfo.truncated`** sagt genau, was `GET /api/file` kürzt: die Quelle oder ihre UTF-8-Form ist
     größer als `fileTextBytes`.
     - Gelesen wird nur, wenn die Obergrenze aus Größe und Kodierung offen lässt, ob die Grenze
       überschritten wird.
     - Das Ergebnis merkt sich der Dienst je Dateiversion (Pfad, Größe, `mtime`; LRU 256).
     - `GET /api/file` braucht das Flag nicht.
  3. **Bilder und PDFs** liest `GET /api/file` über ein Handle ganz (≤ `fileBinaryBytes`) und sendet sie
     mit genauer Länge.
     - `Content-Length` weicht nie vom Körper ab.
     - Eine zwischendurch ersetzte Datei kommt vollständig.
     - Das Lesen läuft wie zuvor der Stream ohne 3-s-Wächter.
  4. **Der Index-Backfill** liest seitenweise rückwärts (neueste Unterhaltung und Seite zuerst) und hält
     höchstens eine Seite.
     - Gezählt wird nur ein Datensatz außerhalb der bekannten Zeitspanne einer Datei.
     - `ops` bleiben in der Reihenfolge des ersten Auftretens.
- **Begründung:**
  - Der Client kennt die Absicht: Datei oder vorbereitetes Bild.
  - Die Anzeige „gekürzt“ muss zum gesendeten Text passen. Die Kosten bleiben beim Pollen gering, weil
    nur eine geänderte Dateiversion gelesen wird – und dann lädt der Viewer den Inhalt ohnehin.
  - Eine Länge, die nicht aus den gesendeten Bytes stammt, kann nie garantiert stimmen.
  - Seiten statt ganzer Unterhaltungen begrenzen die Speicherspitze nach einem Upgrade.
- **Folgen:**
  - Bild-Bytes ohne Browser-Typ liest Claude per `Read` aus dem Anhangordner statt als Bild-Block.
  - Je gleichzeitiger Bild/PDF-Antwort bis 50 MB Speicher.
  - `HEAD /api/file` liest die Datei ganz; die UI nutzt `HEAD` nicht, und der Port kennt die Methode
    nicht.
  - Verworfen wurden „Länge vom Handle + Stream“ und „ohne feste Länge“ (siehe
    `docs/wp/CODE-REVIEW-3-D.md`).

## README-Änderungen
- **Direkt gepflegt (Ordner nur WP-53):**
  - `src/server/files/README.md`: `fileFs.ts` (`readWhole`, Ausnahme vom Wächter), `stat.ts`
    (`truncated` exakt, Cache, Exporte), `content.ts` (ganz gelesen, genaue Länge), `sessionIndex.ts`
    (seitenweise rückwärts, Zählregel), Absatz zum Timeout.
  - `src/server/http/README.md`: Upload Phase 3 (octet-stream nie Bild), `Content-Length` genau,
    Testbeschreibungen.
- **`src/server/lib/README.md`:** kein Nachtrag; in `lib` wurde nichts geändert.

## Hinweise für den Koordinator
- **Doku mit veraltetem Stand** (Koordinator-Dateien):
  - `docs/architecture.md`:
    - Z. 904 und 1107 (Upload: „Bild wie bisher“ → nur deklariertes Bild, octet-stream immer Datei);
    - Z. 1092 (`GET /api/file`: „Bild/PDF als Stream“ → ganz gelesen, genaue Länge);
    - Z. 1096 (Backfill seitenweise rückwärts).
  - `docs/wp/WP-53.md` §2 „Stolpersteine“: „`truncated` ist … eine Schätzung“ ist überholt.
- **Contract-Kommentar** (optional, keine Schemaänderung): `UPLOAD_MEDIA_TYPES` in `src/shared/http.ts`
  sagt „The server decides by magic bytes“. Genauer wäre: „octet-stream is never an image; `%PDF-` →
  PDF“.
- **Blob-Store (nicht Paket D, `store/blobs.ts`, ADR-134 „erste Meta gewinnt“):**
  - Liegen dieselben Bytes schon mit Bild-Meta im Store, etwa vom Normalizer oder von einem Upload vor
    diesem Fix, dann liefert ein octet-stream-Upload weiter die Bild-Ref.
  - Selten und unkritisch: Normalizer-Bilder stammen von der API, und die Engine prüft `imageBytes` beim
    Senden.
  - Ein Follow-up wäre: eine Datei-Meta ersetzt eine Bild-Meta nicht, liefert aber für diesen Upload
    `application/octet-stream`.
- **Optional, Web/Composer:** `attachmentKind` könnte typlose Dateien per Magic-Bytes als Bild erkennen.
  Dann würden sie skaliert und inline gesendet. Für den Fix ist das nicht nötig.
