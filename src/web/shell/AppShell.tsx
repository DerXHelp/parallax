import { TooltipProvider } from '@web/ui/tooltip';
import { HostGate } from './HostGate';
import { NavigationLayer } from './navigation/NavigationLayer';
import { NewSessionDialog } from './NewSessionDialog';
import { NotificationCenter } from './NotificationCenter';
import { PaneLayout } from './PaneLayout';
import { ShellBanners } from './ShellBanners';
import { ShortcutHelp } from './ShortcutHelp';
import { SidebarFrame } from './SidebarFrame';

/**
 * The app frame (Plan "Layout"): sidebar on the left (collapsible, a rail below 900 px window
 * width – SidebarFrame, V3-14), the selected session on the right (pane-capable), banners on top,
 * hints bottom right (local notices + in-app server notifications), `?` shortcut help, "New
 * session" dialog, navigation layer (quick switcher, earlier conversations, session info, rename –
 * WP-35). Feature content comes from the FeatureSlots (slots.tsx, set in App.tsx).
 * Theme/language/title: ShellEffects.
 */
export function AppShell() {
  return (
    <TooltipProvider>
      <HostGate>
        <div className="flex h-full min-h-0">
          <SidebarFrame />
          <main className="flex min-w-0 flex-1 flex-col">
            <ShellBanners />
            <PaneLayout />
          </main>
        </div>
        <NotificationCenter />
        <NewSessionDialog />
        <NavigationLayer />
      </HostGate>
      <ShortcutHelp />
    </TooltipProvider>
  );
}
