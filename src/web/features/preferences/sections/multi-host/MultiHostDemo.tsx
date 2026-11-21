import { useEffect, useState } from 'react';
import { makeError } from '@shared/errors';
import { DEFAULT_MULTI_HOST_CONFIG, type HostState } from '@shared/model';
import { sampleRemoteAccessCheck, sampleRemotePeer, sampleTime } from '@shared/samples';
import { useT } from '@web/i18n';
import { startScenario } from '@web/playground/PlaygroundScenario';
import { useHostState } from '@web/state/hooks';
import { Card } from '@web/ui/card';
import { MultiHostSection } from '../MultiHostSection';
import { MultiHostCommandsProvider, type MultiHostCommands } from './commands';
import { createFakeMultiHost, fakeChecks, sharingHostState, type FakeHostStateTarget } from './fake-commands';

/** Host state variants of the playground demos (on top of the empty scenario). */
export type MultiHostVariant = 'off' | 'share' | 'paired' | 'errors' | 'control';

export function multiHostVariant(base: HostState, variant: MultiHostVariant): HostState {
  switch (variant) {
    case 'off':
      return { ...base, multiHost: DEFAULT_MULTI_HOST_CONFIG, remoteAccess: null };
    case 'share':
      return sharingHostState(base);
    case 'paired':
      return sharingHostState(base, {
        addresses: ['192.0.2.20', '198.51.100.20'],
        checks: fakeChecks(),
        peer: sampleRemotePeer({ lastSeenAt: sampleTime(400) }),
        unseenRejected: 2,
      });
    case 'errors':
      return sharingHostState(base, {
        listening: false,
        error: makeError('REMOTE_ACCESS_FAILED', { reason: 'port_in_use' }),
        checks: [
          sampleRemoteAccessCheck({ id: 'port', status: 'error' }),
          sampleRemoteAccessCheck({ id: 'keys', status: 'ok', params: {} }),
          sampleRemoteAccessCheck({ id: 'keystore', status: 'warning', params: {} }),
          sampleRemoteAccessCheck({ id: 'tls', status: 'ok', params: {} }),
          sampleRemoteAccessCheck({ id: 'addresses', status: 'warning', params: {} }),
        ],
        peer: sampleRemotePeer({ connected: false, connections: 0, compatible: false, appVersion: '9.9.9' }),
      });
    case 'control':
      return { ...base, multiHost: { ...DEFAULT_MULTI_HOST_CONFIG, role: 'control' }, remoteAccess: null };
  }
}

/** Lets the fake be created before the scenario starts (the demo attaches the FakeHost later). */
class DemoTarget implements FakeHostStateTarget {
  private host: FakeHostStateTarget | null = null;
  get attached(): boolean {
    return this.host !== null;
  }
  attach(host: FakeHostStateTarget | null): void {
    this.host = host;
  }
  get hostState(): HostState {
    if (this.host === null) throw new Error('demo host not started');
    return this.host.hostState;
  }
  setHostState(hostState: HostState): void {
    this.host?.setHostState(hostState);
  }
}

/** Seconds until the "controlling computer" types the shown code in the demos. */
const DEMO_PAIRING_MS = 20_000;

/**
 * Playground demo of the section "Several computers" over the FakeHost: the section's commands
 * answer through the fake sharing computer; a shown pairing code is "typed" by the controlling
 * computer after 20 s (the window closes with "Paired with …").
 */
export function MultiHostDemo({ variant }: { variant: MultiHostVariant }) {
  const t = useT();
  const [target] = useState(() => new DemoTarget());
  const [demo] = useState(() => {
    const fake = createFakeMultiHost(target);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const commands: MultiHostCommands = {
      ...fake.commands,
      pair: async (level) => {
        const result = await fake.commands.pair(level);
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        timers.add(
          setTimeout(() => {
            if (target.attached) fake.completePairing('Computer A');
          }, DEMO_PAIRING_MS),
        );
        return result;
      },
    };
    return { commands, timers };
  });
  useEffect(() => {
    const running = startScenario('empty', { select: null });
    target.attach(running.host);
    running.host.setHostState(multiHostVariant(running.host.hostState, variant));
    const { timers } = demo;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      target.attach(null);
      running.stop();
    };
  }, [target, demo, variant]);
  const hostState = useHostState();
  return (
    <MultiHostCommandsProvider value={demo.commands}>
      <div className="mx-auto max-w-2xl p-6">
        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold">{t('preferences.sections.multiHost')}</h3>
          <MultiHostSection hostState={hostState} />
        </Card>
      </div>
    </MultiHostCommandsProvider>
  );
}
