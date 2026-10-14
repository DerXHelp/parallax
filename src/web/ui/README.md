# src/web/ui – UI-Primitives

Einziger Ort für UI-Primitives (shadcn/ui-Komponenten auf Basis von `radix-ui`, Icons aus
`lucide-react`). Features importieren Primitives nur von hier. Farben nur über Design-Tokens
(`bg-background`, `text-muted-foreground`, `text-status-waiting`, …), keine Rohfarben.
shadcn-Konfiguration: `components.json` im Repo-Root (Aliase `@web/ui`, `@web/lib/cn`).
