import { useEffect, useEffectEvent, type ReactNode } from 'react';
import { AppShell } from '@web/shell/AppShell';
import {
  getSidebarMode,
  setArchiveView,
  setSidebarMode,
  type SidebarMode,
} from '@web/shell/navigation/sidebar-view';
import { requestShell, type ShellRequest } from '@web/shell/requests';
import { NAVIGATION_SESSION_KEYS } from './navigation-scenario';
import { PlaygroundScenario } from './PlaygroundScenario';
import type { ScenarioId } from './scenarios';
import type { PlaygroundDemo } from './types';

/** Retries `attempt` every 100 ms until it succeeds (the shell mounts after the handshake). */
function useRetry(attempt: () => boolean): void {
  const tryOnce = useEffectEvent(attempt);
  useEffect(() => {
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      if (tryOnce() || ++tries > 50) return;
      timer = setTimeout(run, 100);
    };
    timer = setTimeout(run, 100);
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}

/** Sets the sidebar view while mounted (the previous mode comes back afterwards). */
function SidebarView({
  mode,
  archive,
  children,
}: {
  mode: SidebarMode;
  archive: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const previous = getSidebarMode();
    setSidebarMode(mode);
    setArchiveView(archive);
    return () => {
      setSidebarMode(previous);
      setArchiveView(false);
    };
  }, [mode, archive]);
  return children;
}

/** Sends a shell request once the shell takes it (quick switcher, earlier conversations, info). */
function Request({ request }: { request: ShellRequest }) {
  useRetry(() => requestShell(request));
  return null;
}

/** Opens a DropdownMenu trigger via the keyboard (Enter), like a user (header menu screenshot). */
function OpenMenu({ selector }: { selector: string }) {
  useRetry(() => {
    const trigger = document.querySelector<HTMLElement>(selector);
    if (trigger === null) return false;
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  });
  return null;
}

function demo(
  id: string,
  title: string,
  options: {
    scenario?: ScenarioId;
    mode?: SidebarMode;
    archive?: boolean;
    extra?: ReactNode;
    description?: string;
  } = {},
): PlaygroundDemo {
  const scenario = options.scenario ?? 'navigation';
  return {
    id,
    title,
    description: options.description,
    render: () => (
      <SidebarView mode={options.mode ?? 'flat'} archive={options.archive ?? false}>
        <PlaygroundScenario scenario={scenario}>
          <AppShell />
          {options.extra}
        </PlaygroundScenario>
      </SidebarView>
    ),
  };
}

/** WP-35 demos (Playground point 12): sidebar views, quick switcher, header menu, banners, limits. */
export const navigationDemos: readonly PlaygroundDemo[] = [
  demo('nav-sidebar-flat', 'Navigation – Sidebar flat (pinned first, limits at the bottom)', {
    description: 'Right-click a row or hover it for “…”; double-click a title or press F2 to rename.',
  }),
  demo('nav-sidebar-grouped', 'Navigation – Sidebar grouped by project', { mode: 'grouped' }),
  demo('nav-sidebar-archive', 'Navigation – Archive view (restore)', { archive: true }),
  demo('nav-quick-switcher', 'Navigation – Quick switcher (Ctrl+K)', {
    extra: <Request request={{ kind: 'quickSwitcher' }} />,
  }),
  demo('nav-header-menu', 'Navigation – Header menu “…”', {
    extra: <OpenMenu selector='[data-slot="session-menu"]' />,
  }),
  demo('nav-conversations', 'Navigation – Earlier conversations', {
    extra: <Request request={{ kind: 'conversations', sessionKey: NAVIGATION_SESSION_KEYS.auth }} />,
  }),
  demo('nav-session-info', 'Navigation – Session info', {
    extra: <Request request={{ kind: 'sessionInfo', sessionKey: NAVIGATION_SESSION_KEYS.auth }} />,
  }),
  demo('nav-external', 'Navigation – Banner: open in an external console', {
    scenario: 'navigation-external',
    description: '“Take back” fails once (EXTERNAL_STILL_RUNNING), then succeeds.',
  }),
  demo('nav-archived', 'Navigation – Banner: archived session', {
    scenario: 'navigation-archived',
    archive: true,
  }),
];
