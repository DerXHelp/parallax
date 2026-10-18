# src/web/ui – UI-Primitives (WP-14)

Einziger Ort für UI-Primitives (shadcn/ui-Stil, „new-york“, auf `radix-ui`; Icons aus
`lucide-react`). Features importieren Primitives nur von hier; direkte `radix-ui`-Importe gibt es
nur in diesem Ordner. Farben nur über Design-Tokens (`bg-background`, `text-muted-foreground`,
`text-status-waiting`, `bg-brand` …, siehe `src/web/index.css`), keine Rohfarben. Eine Datei je
Primitive, **kein Barrel** (`index.ts`). Kompakt: Standardhöhe 28 px, Text `text-ui` (13 px).

| Datei | Exporte |
|---|---|
| `button.tsx` | `Button` (`variant`: default/secondary/outline/ghost/destructive/link, `size`: default/sm/lg/icon/icon-sm/icon-xs, `asChild`), `buttonVariants` |
| `icon-button.tsx` | `IconButton` (Pflicht-`label` = Name + Tooltip, `shortcut`) |
| `badge.tsx` | `Badge` (default/secondary/outline/success/warning/info/destructive) |
| `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` |
| `tooltip.tsx` | `TooltipProvider`, `Tooltip` (nutzt einen vorhandenen Provider, sonst einen eigenen), `TooltipTrigger`, `TooltipContent` |
| `dropdown-menu.tsx` | `DropdownMenu` + `Trigger`, `Content`, `Item` (`variant="destructive"`), `CheckboxItem`, `RadioGroup`, `RadioItem`, `Label`, `Separator`, `Shortcut`, `Sub`, `SubTrigger`, `SubContent`, `Group`, `Portal` |
| `context-menu.tsx` | Phase 2 (WP-35): `ContextMenu` + `Trigger`, `Content`, `Item` (`variant="destructive"`, `inset`), `CheckboxItem`, `Label`, `Separator`, `Shortcut`, `Group`, `Sub`, `SubTrigger`, `SubContent` – Radix-`ContextMenu` im Look von `dropdown-menu` (Rechtsklick, Umschalt+F10, Kontextmenütaste) |
| `popover.tsx` | `Popover`, `PopoverTrigger`, `PopoverAnchor`, `PopoverContent` |
| `dialog.tsx` | `Dialog` + `Trigger`, `Content` (`showCloseButton`), `Header`, `Footer`, `Title`, `Description`, `Close`, `Overlay`, `Portal` – nur für echte Dialoge, Entscheidungen bleiben nicht-modal |
| `command-list.tsx` | Phase 2 (WP-35): durchsuchbare Liste im Combobox-Muster – `CommandInput` (`role="combobox"`, `aria-activedescendant`, Fokus bleibt im Suchfeld), `CommandList` (`role="listbox"`, `items`/`getKey`/`renderItem`, `activeIndex`, `onSelect`, `empty`), `handleCommandKey` (Pfeile zyklisch, Bild↑/↓, Enter mit Modifikatoren `CommandModifiers`; Esc bleibt beim Dialog), `commandOptionId`; Filtern macht der Aufrufer (`lib/fuzzy.ts`) |
| `select.tsx` | `Select`, `SelectTrigger` (`size`), `SelectValue`, `SelectContent`, `SelectItem`, `SelectGroup`, `SelectLabel`, `SelectSeparator` |
| `collapsible.tsx` | `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` (ungestylt) |
| `disclosure.tsx` | `Disclosure` (Chevron-Umschalter als echter `<button>` mit `aria-expanded`, `header`, `actions` neben dem Knopf, `label`; kontrolliert `open`/`onOpenChange` oder `defaultOpen`; Inhalt nur offen gemountet – R2W-08) |
| `scroll-area.tsx` | `ScrollArea` (`viewportClassName`), `ScrollBar` |
| `separator.tsx` | `Separator` |
| `input.tsx`, `textarea.tsx`, `label.tsx` | `Input`, `Textarea` (`field-sizing: content`), `Label` |
| `toggle.tsx`, `toggle-group.tsx` | `Toggle`, `toggleVariants`, `ToggleGroup`, `ToggleGroupItem` |
| `radio-group.tsx`, `checkbox.tsx`, `switch.tsx` | `RadioGroup`, `RadioGroupItem`, `Checkbox`, `Switch` |
| `tabs.tsx` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` |
| `kbd.tsx` | `Kbd`, `KbdGroup` (Tastennamen übersetzt: `shortcutKeyLabels` in `shell/shortcuts.ts`) |
| `progress.tsx`, `gauge.tsx` | `Progress` (Fortschritt), `Gauge` (Pegel, `role="meter"`, Schwellen 70/85 %), `gaugeLevel`, `GAUGE_THRESHOLDS` |
| `skeleton.tsx`, `spinner.tsx` | `Skeleton`, `Spinner` (`role="status"`, Label per `t()`) |
| `alert.tsx` | `Alert` (`tone`: info/warning/error/success, `title`, `actions`), `Banner` (Streifen oben), `TONE_ICON`, `AlertTone` |
| `slider.tsx` | `Slider` (Radix; Pflicht-`thumbLabel`, `valueText(value)` → `aria-valuetext`, `onValueChange` beim Ziehen, `onValueCommit` am Ende; WP-38) |
| `lightbox.tsx` | `Lightbox` (Bild im Vollbild-Dialog, Zoom `ZOOM_STEP`/`ZOOM_MIN`/`ZOOM_MAX`, `fitScale`, Labels per Prop, Fokus-Rückgabe über `onCloseAutoFocus`), `LightboxImage`, `LightboxLabels` (WP-37) |
| `status-icon.tsx` | `StatusIcon` (`DisplayStatusKind` → Icon + `t('status.<kind>')`, `showLabel`, `withTooltip`; nie nur Farbe), `STATUS_PRESENTATION`, `STATUS_KINDS` |

Barrierearm: jedes Icon-only-Element hat einen Namen (`label`/`aria-label` aus `t()`), Status
immer Icon + Text, Fokus-Ring über `ring`-Token, Animationen nur mit `motion-safe:`.

In Welle 1b ist dieser Ordner **read-only**: Fehlt etwas, bauen WP-15/16 eine Komposition aus
vorhandenen Primitives in `features/<f>/components/` und melden den Wunsch im Bericht.
