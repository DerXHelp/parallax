# src/web/shell/new-session – Neue Session (Phase 2)

Owner: **WP-36** (zusammen mit `../NewSessionDialog.tsx`, `../NewSessionForm.tsx`,
`../EmptyState.tsx`). Auftrag und Ergebnis: `docs/wp/WP-36.md`.

Ordner-Browser (`fs.listDirectory`, ADR-119), Profilwahl und zuletzt genutzte Projekte des Dialogs
„Neue Session“. Handler des Anfragekanals (`../requests.ts`): `newSession` (Vorbelegung `cwd`,
`profileId`) in `../NewSessionDialog.tsx`; `openNewSession(prefill?)` ist der Wrapper darum. Der
Dialog merkt sich beim Öffnen das fokussierte Element und gibt ihm den Fokus beim Schließen zurück
(V3-04); lange Pfade enden mit einer Ellipse, die Spalten wachsen nicht mit (V3-01).

| Pfad | Inhalt |
| --- | --- |
| `FolderBrowser.tsx` | `FolderBrowser` (Dialog mit Trigger-Kind): Wurzeln/Start-Ordner, Brotkrumen (bei langen Pfaden ans Ende gescrollt, V3-01), „Nach oben“, „Versteckte anzeigen“, Tastatur, „Diesen Ordner wählen“ übernimmt `path` exakt. Auch vom Profil-Editor genutzt (`configDir`). WP-64: nur noch Dialog + Trigger; der Inhalt ist ein Lazy-Chunk (Start-Chunk-Budget) |
| `FolderBrowserContent.tsx` | Inhalt des Ordner-Browsers (Default-Export, lazy geladen beim Öffnen; Fehler des Chunks → Karte der `SlotBoundary`), `breadcrumbs(path)` |
| `ProfileSelect.tsx` | `ProfileSelect` (Menü: Farbe, Name, „Standard“, Claude-Code-Zustand; Profile mit Fehler-Befunden gesperrt, Gründe im Tooltip) |
| `profile-status.tsx` | `ProfileStatus`, `profileStatusText`, `ProfileColorDot`, `ProfileIssueText`, `profileErrors` (leer = Profil nutzbar) – gemeinsam mit `features/profiles`; WP-62: Ton `info` „neuer als geprüft“ (`newSession.status.untested`/`untestedPlan`), wenn `version` neuer als `testedVersion` |
| `profile-issues.ts` | Details eines Befunds (`issueDetail`, `issueArgIndex`, `issueField`, `issueEnvKey`, `issueCounts`) – nie Env-Werte |
| `recent-projects.ts` | `recentProjects(entries)` (max. 8, case-insensitiv per `windowsPathKey`, archivierte inklusive), `filterRecentProjects` (Fuzzy, `lib/fuzzy.ts`) |
| `demo-folders.ts`, `demo-host.ts` | nur Tests/Playground: Ordnerbaum für `fs.listDirectory`, FakeHost hinter einer echten `HostConnection` (`startNewSessionDemo`) |
| `i18n/{en,de}.ts` | Namensraum `newSession` (registriert in `src/web/i18n/dictionaries.ts` bzw. `dictionary.de.ts`, ADR-153); auch Status- und Befundtexte der Profile |

Tests: `FolderBrowser.test.tsx`, `new-session-lib.test.ts`, `i18n/i18n.test.ts` (gleiche Schlüssel,
keine Literale in `aria-label`/`title`/`placeholder`/`alt`), dazu `../NewSessionDialog.test.tsx` und
`../NewSessionForm.test.tsx`.
