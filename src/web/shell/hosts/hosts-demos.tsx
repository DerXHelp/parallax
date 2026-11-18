import { useEffect, type ReactNode } from 'react';
import { sampleRemoteAccessState, sampleRemotePeer } from '@shared/samples';
import { startScenario } from '@web/playground/PlaygroundScenario';
import type { PlaygroundDemo } from '@web/playground/types';
import { AppShell } from '../AppShell';
import { openNewSession } from '../NewSessionDialog';
import { requestShell } from '../requests';
import { setSidebarGrouping } from '../navigation/sidebar-view';
import { DEMO_HOST_KEYS, DEMO_HOSTS, DEMO_SHARED_FOLDER, startHostsDemo } from './hosts-demo';

/**
 * Playground demos of "Several computers" in the window (WP-80): the sidebar with two other
 * computers (grouped by computer and folder), unavailable computers with their banner, "New
 * session" on another computer, the settings part "Control others" and the header icon of a
 * sharing computer. Data: the navigation scenario plus `hosts-demo.ts`.
 */

type Variant = 'grouped' | 'unavailable' | 'newSession' | 'settings';

function HostsScenario({ variant, children }: { variant: Variant; children: ReactNode }) {
  useEffect(() => {
    const running = startHostsDemo(variant === 'unavailable' ? { select: DEMO_HOST_KEYS.pipeline } : {});
    switch (variant) {
      case 'grouped':
        setSidebarGrouping({ byHost: true, byFolder: true });
        break;
      case 'unavailable':
        running.computers.setReachable(DEMO_HOSTS.b, false);
        running.computers.makeIncompatible(DEMO_HOSTS.c, '9.9.9');
        break;
      case 'newSession':
        openNewSession({ cwd: DEMO_SHARED_FOLDER, hostId: DEMO_HOSTS.b });
        break;
      case 'settings':
        requestShell({ kind: 'settings', section: 'multiHost' });
        break;
    }
    return () => {
      running.stop();
      if (variant === 'grouped') setSidebarGrouping({ byHost: false, byFolder: false });
    };
  }, [variant]);
  return children;
}

/** This computer shares: a connected controlling computer and three rejected attempts. */
function SharingScenario({ children }: { children: ReactNode }) {
  useEffect(() => {
    const running = startScenario('navigation');
    const state = running.host.hostState;
    running.host.setHostState({
      ...state,
      multiHost: { ...state.multiHost, role: 'share' },
      remoteAccess: sampleRemoteAccessState({ peer: sampleRemotePeer(), unseenRejected: 3 }),
    });
    return () => {
      running.stop();
    };
  }, []);
  return children;
}

export const hostsDemos: readonly PlaygroundDemo[] = [
  {
    id: 'shell-hosts-sidebar',
    title: 'Several computers – sidebar grouped by computer and folder (WP-80)',
    description: 'Two other computers; group headers collapse (state per window), Alt+N expands the target.',
    render: () => (
      <HostsScenario variant="grouped">
        <AppShell />
      </HostsScenario>
    ),
  },
  {
    id: 'shell-hosts-unavailable',
    title: 'Several computers – one computer not reachable, one with another version (WP-80)',
    description: 'Grey rows, banner of the selected session with “Reconnect”.',
    render: () => (
      <HostsScenario variant="unavailable">
        <AppShell />
      </HostsScenario>
    ),
  },
  {
    id: 'shell-hosts-new-session',
    title: 'Several computers – “New session” on another computer (WP-80)',
    render: () => (
      <HostsScenario variant="newSession">
        <AppShell />
      </HostsScenario>
    ),
  },
  {
    id: 'shell-hosts-settings',
    title: 'Several computers – settings part “Control others” (WP-80)',
    render: () => (
      <HostsScenario variant="settings">
        <AppShell />
      </HostsScenario>
    ),
  },
  {
    id: 'shell-hosts-sharing',
    title: 'Several computers – header icon of a sharing computer with rejected attempts (WP-80)',
    render: () => (
      <SharingScenario>
        <AppShell />
      </SharingScenario>
    ),
  },
];
