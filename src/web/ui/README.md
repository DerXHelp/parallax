# src/web/ui – UI-Primitives (WP-14)

Einziger Ort für UI-Primitives (shadcn/ui-Komponenten auf Basis von `radix-ui`, Icons aus
`lucide-react`). Features importieren Primitives nur von hier; direkte `radix-ui`-Importe gibt es
nur in diesem Ordner. Farben nur über Design-Tokens (`bg-background`, `text-muted-foreground`,
`text-status-waiting`, …), keine Rohfarben. shadcn-Konfiguration: `components.json` im Repo-Root
(Aliase `@web/ui`, `@web/lib/cn`). Eine Datei je Primitive, **kein Barrel** (`index.ts`).

WP-14 liefert für Welle 1b mindestens (R0-03): Button, Badge, Card, Tooltip, DropdownMenu, Popover,
Dialog, Select, Collapsible, ScrollArea, Separator, Input, Textarea, ToggleGroup, RadioGroup,
Checkbox, Tabs, Kbd, Progress, Skeleton, Spinner, Alert/Banner und `StatusIcon`
(`DisplayStatusKind` → Icon + `t('status.<kind>')`, auch `needs-resume`; nie nur Farbe).

In Welle 1b ist dieser Ordner **read-only**: Fehlt etwas, bauen WP-15/16 eine Komposition aus
vorhandenen Primitives in `features/<f>/components/` und melden den Wunsch im Bericht.
