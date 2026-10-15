import { useEffect, useEffectEvent, useRef, type ReactNode, type RefObject } from 'react';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import type { Command } from '@shared/protocol';
import { NotificationCenter } from '@web/shell/NotificationCenter';
import { SessionPane } from '@web/shell/SessionPane';
import type { FakeAck, FakeHost } from '@web/state/fake-host';
import { Button } from '@web/ui/button';
import { DEMO_ENTRIES, demoData, demoHostState, type DemoEntry } from './demo-data';
import { startDemoHost, type DemoHost } from './demo-host';

/**
 * Playground frame of WP-16 (dev only): starts a demo host with the given sample sessions and
 * shows one of them in the real `SessionPane` of the shell (header, transcript slot, side panel
 * slot, decision bar region, composer slot) – the slots come from the playground's
 * FeatureSlotsProvider (this feature's `slots` + WP-15's). Local notices need the
 * NotificationCenter, so it is mounted here (ADR-033).
 */
export function DemoSession({
  entries,
  show,
  onCommand,
  replyToPrompts = true,
  controls,
  above,
}: {
  entries: readonly DemoEntry[];
  show: DemoEntry;
  onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined;
  replyToPrompts?: boolean;
  /** Demo-only buttons (developer text); `host.current` is the running demo host (read on click). */
  controls?: (host: RefObject<DemoHost | null>) => ReactNode;
  /** Rendered above the pane (e.g. the read-only transcript card). */
  above?: (sessionKey: string) => ReactNode;
}) {
  const running = useRef<DemoHost | null>(null);
  const sessionKey = makeSessionKey(LOCAL_HOST_ID, DEMO_ENTRIES[show]);
  const entriesKey = entries.join(',');
  const handleCommand = useEffectEvent((cmd: Command, host: FakeHost) => onCommand?.(cmd, host));

  useEffect(() => {
    const names = entriesKey.split(',').filter((name): name is DemoEntry => name in DEMO_ENTRIES);
    const host = startDemoHost({
      ...demoData(names),
      hostState: demoHostState(),
      onCommand: (cmd, fake) => handleCommand(cmd, fake),
      replyToPrompts,
      select: sessionKey,
    });
    running.current = host;
    return () => {
      running.current = null;
      host.stop();
    };
  }, [entriesKey, replyToPrompts, sessionKey]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {controls === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">{controls(running)}</div>
      )}
      {above === undefined ? null : (
        <div className="max-h-[45%] shrink-0 overflow-auto border-b p-3">{above(sessionKey)}</div>
      )}
      <div className="min-h-0 flex-1">
        <SessionPane sessionKey={sessionKey} />
      </div>
      <NotificationCenter />
    </div>
  );
}

/** A demo control with developer text (the label is a prop, not a UI string). */
export function DemoButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="secondary" onClick={onClick}>
      {label}
    </Button>
  );
}
