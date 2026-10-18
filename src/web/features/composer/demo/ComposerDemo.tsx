import { useEffect, useEffectEvent, useRef, type ReactNode, type RefObject } from 'react';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import type { Command } from '@shared/protocol';
import { NavigationLayer } from '@web/shell/navigation/NavigationLayer';
import { NotificationCenter } from '@web/shell/NotificationCenter';
import { SessionPane } from '@web/shell/SessionPane';
import { ShortcutHelp } from '@web/shell/ShortcutHelp';
import type { FakeAck, FakeHost } from '@web/state/fake-host';
import {
  DEMO_ENTRIES,
  demoData,
  demoHostState,
  type DemoData,
  type DemoEntry,
} from '../../decisions/lib/demo-data';
import { startDemoHost, type DemoHost } from '../../decisions/lib/demo-host';
import { setAttachmentUploader } from '../lib/upload';
import { resetAttachments } from '../state/attachments';
import { demoUploader } from './data';

/**
 * Playground frame of the WP-37 demos (dev only): a demo host with one sample session whose data
 * `setup` may change before the start (catalog, suggestion, limits …), shown in the real
 * SessionPane. The navigation layer answers `/rename`, `/status`, `/resume`; the shortcut help
 * opens from `/help`. Uploads go to a fake uploader (no server behind Vite).
 */
export function ComposerDemo({
  entry = 'idle',
  setup,
  onCommand,
  controls,
}: {
  entry?: DemoEntry;
  setup?: (data: DemoData) => DemoData;
  onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined;
  /** Demo-only buttons (developer text); `host.current` is the running demo host. */
  controls?: (host: RefObject<DemoHost | null>) => ReactNode;
}) {
  const running = useRef<DemoHost | null>(null);
  const sessionKey = makeSessionKey(LOCAL_HOST_ID, DEMO_ENTRIES[entry]);
  const prepare = useEffectEvent((data: DemoData) => setup?.(data) ?? data);
  const handleCommand = useEffectEvent((cmd: Command, host: FakeHost) => onCommand?.(cmd, host));

  useEffect(() => {
    setAttachmentUploader(demoUploader);
    const host = startDemoHost({
      ...prepare(demoData([entry])),
      hostState: demoHostState(),
      onCommand: (cmd, fake) => handleCommand(cmd, fake),
      replyToPrompts: true,
      select: sessionKey,
    });
    running.current = host;
    return () => {
      running.current = null;
      host.stop();
      // Every demo starts without chips (they are kept per session key in memory).
      resetAttachments();
      setAttachmentUploader(null);
    };
  }, [entry, sessionKey]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {controls === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">{controls(running)}</div>
      )}
      <div className="min-h-0 flex-1">
        <SessionPane sessionKey={sessionKey} />
      </div>
      <NavigationLayer />
      <ShortcutHelp />
      <NotificationCenter />
    </div>
  );
}
