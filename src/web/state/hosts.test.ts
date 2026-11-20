import { describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { SAMPLE_IDS, SAMPLE_REMOTE_HOST_ID, sampleHostState } from '@shared/samples';
import { selectTerminalAvailable } from './hosts';
import { createClientStore, updateHost } from './store';

describe('selectTerminalAvailable (WP-99)', () => {
  const local = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
  const remote = makeSessionKey(SAMPLE_REMOTE_HOST_ID, SAMPLE_IDS.entry);

  it('is true only for a session of this computer whose server has a pseudo console', () => {
    const store = createClientStore();
    expect(selectTerminalAvailable(store.getState(), local)).toBe(false);
    updateHost(store, LOCAL_HOST_ID, () => ({ hostState: sampleHostState({ terminalAvailable: false }) }));
    expect(selectTerminalAvailable(store.getState(), local)).toBe(false);
    updateHost(store, LOCAL_HOST_ID, () => ({ hostState: sampleHostState({ terminalAvailable: true }) }));
    expect(selectTerminalAvailable(store.getState(), local)).toBe(true);
    // Never for another computer – even when that one would have a pseudo console.
    updateHost(store, SAMPLE_REMOTE_HOST_ID, () => ({
      hostState: sampleHostState({ terminalAvailable: true }),
    }));
    expect(selectTerminalAvailable(store.getState(), remote)).toBe(false);
    expect(selectTerminalAvailable(store.getState(), 'not a session key')).toBe(false);
  });
});
