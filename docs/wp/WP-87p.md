# WP-87p – Vorarbeiten Server für das Update (Teil von 87-0)

Auftrag: `docs/wp/WP-87.md` §1.9 Punkte 1–5 (Entwurf des Koordinators), Branch `wp/87p`. Der Koordinator übernimmt
den Abschnitt unten in `WP-87.md`.

## 87p – Ergebnis

Umgesetzt in `src/server/install/{install,layout,testPackage}.ts` (+ `install.test.ts`, `README.md`),
`src/server/store/backup.ts` (+ Test), neu `src/shared/changelog.ts` (+ Test), `scripts/release/changelog.ts`,
`scripts/release-pack.ts`, `test/setup/home.ts` (+ `env.test.ts`). Keine Änderung an Contracts außer der neuen,
reinen Datei `src/shared/changelog.ts` (vom Auftrag verlangt), keine neuen Fehlercodes, keine Abhängigkeit.

### Installation geteilt (`install.ts`, `layout.ts`)

- **`stageVersion(options, deps)`** → `{ release, bytes, dir, reused }` (`bytes` = signierte `release.json`,
  `dir` = `versions\<v>`). `options` = `InstallOptions` + `signal?` + `onProgress?(step, done, total)`;
  `deps` = `StageDeps` (`provideSdk`, `log`, `now` aus `InstallDeps`). Gleiche Schritte, Meldungen und Reihenfolge wie
  bisher in `installPackage`.
  - **Fortschritt je Datei** (der Aufrufer drosselt): `check` = gehashte Dateien des Pakets (`total` = alle Dateien
    des Pakets samt `release.json` und Signatur); `copy` = kopierte Dateien und danach die erneut geprüften in der
    Kopie (`total` = doppelte Anzahl der kopierten, steigt monoton); `sdk` = `0/1` vor und `1/1` nach dem SDK-Schritt.
    Ein intakter Versionsordner (`reused`) meldet nur `check`; dessen eigene Prüfung (`isIntact`) läuft ohne Meldung.
  - **Abbruch:** `signal` wird vor dem Start, vor jeder Datei (Prüfen, Kopieren), vor und nach dem SDK-Schritt
    geprüft; es fliegt `signal.reason` (`AbortError`), der Staging-Ordner wird entfernt. Der SDK-Schritt selbst ist
    nicht abbrechbar (`provideSdk` kennt kein Signal).
  - **Kopie:** Scheitert eine Datei, stoppen alle Arbeiter, und der Fehler wird erst geworfen, wenn alle fertig sind –
    vorher konnte das Aufräumen des Staging-Ordners mit noch laufenden Kopien zusammenfallen.
- **`switchVersion(root, version, { previous?, log })`** → `{ previous, before }`: liest `release.json` des
  Versionsordners (ohne Signatur; `minNode` für `parallax.cmd`), schreibt Stammdateien und `current.json`. Ohne
  `previous` gilt die Regel des Installers. `before` = altes `current.json` oder `null` (fehlte/kaputt, mit Hinweis
  über `log`).
- **`restoreCurrent(root, before)`:** zuerst `current.json` per `writeCurrent` (byte-gleich zu jeder Datei, die
  Installer oder Umschalter geschrieben haben; eine von Hand umformatierte Datei kommt normalisiert zurück), dann die
  Stammdateien der Version aus `before` (aus deren `root\` oder die Vorlagen des laufenden Codes). `before = null`
  löscht `current.json`, die Stammdateien bleiben.
- **`verifyVersion(root, version, keys = RELEASE_PUBLIC_KEYS)`** → `ReleaseInfo`: Signatur, Version in
  `release.json` = `version`, SDK-Name/-Version, jede gelistete Datei mit Hash, keine fremde Datei (SDK-Ordner
  ausgenommen). Wirft `InstallError`.
- **`InstallError.reason`** (`INSTALL_ERROR_REASONS`, Typ `InstallErrorReason`), Standard `io`: fehlende
  `release.json` → `files`, unlesbare → `io`; fehlende oder falsche Signatur → `signature`; ungültiges JSON/Schema
  nach gültiger Signatur → `files`; `minNode` → `node`; Dateiliste → `files`; SDK fehlt oder falsche Version →
  `sdk`; Versionsordner gesperrt → `in_use`; `--use` einer nicht installierten Version → `files`.
  **`installErrorReason(error)`** mappt jeden Fehler: `InstallError` → `reason`, `SdkError` → `sdk`, sonst `io`
  (also auch ein `AbortError` – 87a prüft `signal.aborted` zuerst).
- **`installPackage`/`useVersion`** sind aus den Teilen zusammengesetzt; alle bestehenden Tests unverändert grün.
  Einzige Abweichung: eine ungültige `release.json` beim Umschalten (`--use`) wirft jetzt `InstallError` (`files`)
  statt eines rohen `ZodError` – der Installer zeigt damit eine Meldung statt „Unexpected installer error“.

### Stammdateien aus dem Paket

- `layout.ts`: `PACKAGE_ROOT_DIR = 'root'`. `install.ts`: `packageRootFiles(minNode)` →
  `{ 'root/start.mjs': startScript(), 'root/parallax.cmd': startCmd(minNode) }` – eine Quelle für `release-pack` und
  `testPackage`.
- `scripts/release-pack.ts` schreibt beide Dateien vor der Dateiliste ins Paket; sie stehen damit in `release.json`
  und sind signiert. Für `release-pack` gibt es keine Tests (Skript mit `main` beim Import, schwer, Netz);
  `release-helpers.test.ts` brauchte keine Anpassung. `scripts/release/smoke.ts` prüft `root/` noch nicht (89).
- `writeRootFiles` nimmt **jede der beiden Dateien einzeln** aus `versions\<v>\root\`, wenn sie dort liegt (fehlender
  Ordner oder Datei → Vorlage des laufenden Codes; ein anderer Lesefehler wirft `InstallError`).
- `testPackage.ts`: Option `rootFiles: true` liefert `root/` wie `release-pack`; `files` kann einzelne ersetzen.

### Sicherungen (`store/backup.ts`)

- `listBackups(home)` → `BackupInfo[]` (`{ dir, name, manifest }`): fertige Sicherungen mit gültigem Manifest, neueste
  zuerst nach `createdAt`, bei gleicher Zeit nach Name (`-2` vor dem ersten); `.partial-*` und unlesbare werden
  übersprungen. `pruneBackups` nutzt dieselbe Sortierung (`newestFirst`), sonst unverändert.
- `findBackup(home, { from, to })` → `BackupInfo | null`: die neueste mit genau diesen Build-IDs (exakter
  Stringvergleich; `from: null` trifft nur Sicherungen eines ersten Starts ohne `last-version.json`).

### Changelog (`src/shared/changelog.ts`)

- Parser unverändert aus `scripts/release/changelog.ts` übernommen (`parseChangelog`, `findSection`,
  `releaseSection`, `UNRELEASED`, `GROUPS`). Der Abschnittstyp heißt in Shared `ParsedChangelogSection` (in
  `@shared/http` steht schon `ChangelogSection` = Schema-Typ); `scripts/release/changelog.ts` exportiert alles unter
  den alten Namen weiter (`ChangelogSection`) und behält `checkTag` (CI-Regel). Bestehende Tests unverändert grün.
- Neu: `ChangelogNotes` (`{ version, date, body }`, strukturell gleich `changelogSectionSchema`),
  `changelogNotes(section)` (ohne `line`/`groups`) und `sectionsBetween(changelog, from, to)` →
  `ChangelogNotes[]`: freigegebene Abschnitte mit `from < v ≤ to` (`from: null` = ohne Untergrenze), Reihenfolge wie
  in der Datei; leer und `to` Vorabversion → „Unveröffentlicht“ (falls vorhanden), sonst `[]`. Unlesbare Versionen
  zählen nicht. `releaseSection` gab es schon.

### Testumgebung

`SERVER_CONTROL_VARS` + `PARALLAX_UPDATE_READY_TIMEOUT_S`, `PARALLAX_TEST_UPDATE_BASE`, `PARALLAX_TEST_RELEASE_KEYS`,
`PARALLAX_TEST_REGISTRY`; `env.test.ts` prüft das Entfernen (auch in Kleinschreibung).

### Prüfung

`pnpm exec vitest run src/server/install src/server/store/backup.test.ts src/shared/changelog.test.ts scripts/release
test/setup/env.test.ts`: 14 Dateien, 182 Tests grün (neu: 19 in `install.test.ts`, 2 in `backup.test.ts`, 15 in
`changelog.test.ts`, erweitert `env.test.ts`). ESLint und Prettier auf allen geänderten Dateien sauber, `tsc -b` grün.

### Für den Koordinator

- `src/shared/README.md` (Zeile `changelog.ts`) und `src/server/store/README.md` (`listBackups`, `findBackup`) sind
  nicht in meinem Besitz und noch nicht ergänzt.
- `provideSdk` (86b) nimmt kein `AbortSignal`; soll das Vorbereiten beim Shutdown auch den SDK-Download abbrechen,
  braucht `sdk.ts` eine Option `signal` (dann in `SdkRequest` durchreichen).
