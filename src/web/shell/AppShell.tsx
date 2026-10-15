import { TooltipProvider } from '@web/ui/tooltip';
import { HostGate } from './HostGate';
import { NotificationCenter } from './NotificationCenter';
import { PaneLayout } from './PaneLayout';
import { ShellBanners } from './ShellBanners';
import { ShortcutHelp } from './ShortcutHelp';
import { Sidebar } from './Sidebar';

/**
 * The app frame (Plan "Layout"): sidebar on the left, the selected session on the right
 * (pane-capable), banners on top, in-app notifications bottom right, `?` shortcut help.
 * Feature content comes from the FeatureSlots (slots.tsx). Theme/language/title: ShellEffects.
 */
export function AppShell() {
  return (
    <TooltipProvider>
      <HostGate>
        <div className="flex h-full min-h-0">
          <Sidebar />
          <main className="flex min-w-0 flex-1 flex-col">
            <ShellBanners />
            <PaneLayout />
          </main>
        </div>
        <NotificationCenter />
      </HostGate>
      <ShortcutHelp />
    </TooltipProvider>
  );
}
