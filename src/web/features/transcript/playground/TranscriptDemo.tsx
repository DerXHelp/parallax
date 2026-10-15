import { useEffect, type ReactNode } from 'react';
import { startScenario } from '@web/playground/PlaygroundScenario';
import { NotificationCenter } from '@web/shell/NotificationCenter';
import { BlobLoadError, setFullTextLoader } from '../state/full-text';
import { demoBlobText, demoSessions } from './data';
import { startStreamingDemo } from './live';

/**
 * Runs the transcript demo sessions while mounted (dev only): the WP-14 scenario "empty" (FakeHost
 * over the MemoryTransport, a real HostConnection), plus this feature's sessions from
 * `data.ts`, the live script of the streaming demo and a blob loader with generated full texts
 * (the playground has no server). One instance per demo (R1-web hint).
 */
export function TranscriptDemo({ live = false, children }: { live?: boolean; children: ReactNode }) {
  useEffect(() => {
    const running = startScenario('empty', { select: null });
    for (const session of demoSessions(Date.now())) {
      running.host.addSession(session.snapshot);
      running.host.upsertSummary(session.summary);
    }
    setFullTextLoader((blobId) => {
      const text = demoBlobText(blobId);
      return new Promise((resolve, reject) => {
        running.host.later(() => {
          if (text === null) reject(new BlobLoadError({ code: 'BLOB_NOT_FOUND', params: {} }));
          else resolve(text);
        }, 400);
      });
    });
    const stopLive = live ? startStreamingDemo(running.host, Date.now) : null;
    return () => {
      stopLive?.();
      setFullTextLoader(null);
      running.stop();
    };
  }, [live]);
  return (
    <div className="relative h-full min-h-0">
      {children}
      <NotificationCenter />
    </div>
  );
}
