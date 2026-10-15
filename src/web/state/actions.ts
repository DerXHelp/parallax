import { parseSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import { mergeItems } from '@shared/sync';
import { ClientCommandError, getConnection } from './connection';
import { clientStore, updateSession, type ClientStore } from './store';

/**
 * Session actions that change the client view and therefore live in state/ (features cannot write
 * the store). Everything else is a plain command via `sendCommand`/`useCommand`.
 */

/** Items per `transcript.loadEarlier` unless given (≤ LIMITS.loadEarlierMax). */
export const LOAD_EARLIER_DEFAULT = 100;

const inFlight = new Map<string, Promise<boolean>>();

/**
 * "Load earlier" (A.2): asks for items before the oldest loaded one of the current conversation
 * and merges them with `mergeItems` (@shared/sync) – existing items win. Resolves true if items were
 * added; false if nothing is earlier, the view is missing or the conversation changed meanwhile.
 * Concurrent calls for the same session share one request. Rejects with ClientCommandError.
 */
export function loadEarlier(
  sessionKey: string,
  options: { limit?: number; store?: ClientStore } = {},
): Promise<boolean> {
  const running = inFlight.get(sessionKey);
  if (running !== undefined) return running;
  const store = options.store ?? clientStore;
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) {
    return Promise.reject(new ClientCommandError(makeError('VALIDATION_FAILED', { path: 'sessionKey' })));
  }
  const view = store.getState().sessions[sessionKey]?.view ?? null;
  const oldest = view?.items[0];
  if (view === null || !view.hasEarlier || oldest === undefined) return Promise.resolve(false);

  const request = getConnection(parsed.hostId)
    .send({
      name: 'transcript.loadEarlier',
      entryId: parsed.entryId,
      conversationId: view.conversationId,
      beforeOrder: oldest.order,
      limit: options.limit ?? LOAD_EARLIER_DEFAULT,
    })
    .then((result) => {
      const current = store.getState().sessions[sessionKey]?.view ?? null;
      if (current?.conversationId !== view.conversationId) return false;
      updateSession(store, sessionKey, () => ({
        view: { ...current, items: mergeItems(current.items, result.items), hasEarlier: result.hasEarlier },
      }));
      return result.items.length > 0;
    })
    .finally(() => {
      inFlight.delete(sessionKey);
    });
  inFlight.set(sessionKey, request);
  return request;
}
