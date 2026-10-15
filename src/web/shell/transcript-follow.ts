import { useEffect, useEffectEvent } from 'react';

/**
 * "Show the latest" across features (V2-06): after the user sent a message from the composer
 * (WP-16), the transcript of that session (WP-15) sticks to its end again – even when it was
 * scrolled up ("Jump to latest" visible) – so the own message and the answer appear in view. The
 * features never import each other (architecture §2.3d); both use this shell module. Only ever
 * called from a user action of this window.
 */

type FollowHandler = () => void;

const handlers = new Map<string, FollowHandler[]>();

/** Registers a handler for one session; returns the remove function. */
export function registerTranscriptFollowHandler(sessionKey: string, handler: FollowHandler): () => void {
  const list = handlers.get(sessionKey) ?? [];
  list.push(handler);
  handlers.set(sessionKey, list);
  return () => {
    const current = handlers.get(sessionKey);
    if (current === undefined) return;
    const index = current.indexOf(handler);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) handlers.delete(sessionKey);
  };
}

/** For the transcript (WP-15): follow requests of its session while mounted. */
export function useTranscriptFollowHandler(sessionKey: string, handler: FollowHandler): void {
  const run = useEffectEvent(() => {
    handler();
  });
  useEffect(
    () =>
      registerTranscriptFollowHandler(sessionKey, () => {
        run();
      }),
    [sessionKey],
  );
}

/** For the composer (WP-16): the user just sent something – show the end of the transcript. */
export function followTranscript(sessionKey: string): void {
  for (const handler of [...(handlers.get(sessionKey) ?? [])]) handler();
}
