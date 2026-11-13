# src/web/features/transcript/i18n-lazy – Lazy-Texte des Transkripts (WP-69)

Texte, die nur lazy geladene Module des Transkripts brauchen – Hook-Läufe (`items/SystemRow.tsx`,
`items/StepGroupRow.tsx`), „Verlauf“ an der Agent-Karte (`items/AgentCard.tsx`) und der Seitenpanel-Tab „Agent“
(`subagent/SubagentPanel.tsx`). Diese Module importieren den Namensraum selbst; Englisch und Deutsch kommen mit
ihren Chunks, nie mit dem Start-Chunk (Start-Budget; Muster von WP-67 `useInfoT`, `translateFrom`). Nicht in
`src/web/i18n/dictionaries.ts` bzw. `dictionary.de.ts` registriert.

| Datei | Inhalt |
| --- | --- |
| `en.ts`, `de.ts` | Wörterbücher (`de: typeof en`); Schlüssel ohne Namensraum-Präfix (`group.hookCount`, `agent.*`, `system.hook*`, `subagent.*`) |
| `index.ts` | `useLazyTranscriptT()` – `t` dieser Texte, an die aktuelle Sprache gebunden; Typen `LazyTranscriptKey`, `LazyTranscriptT` |
| `i18n.test.ts` | Deutsch spiegelt Englisch (Schlüssel, Pluralformen, Platzhalter), jeder Schlüssel wird benutzt, keine Dopplung im statischen Wörterbuch |

Neue Texte des Transkripts, die nur in Lazy-Chunks erscheinen, gehören hierher; Texte des Start-Chunks
(Ladezustand, Slots) bleiben in `../i18n/`.
