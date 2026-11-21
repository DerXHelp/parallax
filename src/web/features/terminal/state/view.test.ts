import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/common';
import { SAMPLE_IDS, sampleHostState } from '@shared/samples';
import { clientStore, resetClientStore, updateHost } from '@web/state/store';
import { createFakeEngineFactory } from '../lib/fake-engine';
import {
  FakeTerminalServer,
  fakeTerminalEnvironment,
  sampleTerminalId,
  sampleTerminalInfo,
  TERMINAL_SESSION_KEY,
  TERMINAL_SOCKET_URL,
} from '../testing';
import { TerminalController } from './controller';
import type { TerminalEnvironment } from './environment';
import { resetTerminalStores } from './terminals';
import { RESIZE_DEBOUNCE_MS, TerminalViewRuntime } from './view';

const TERMINAL = sampleTerminalId(1);
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetTerminalStores();
  resetClientStore();
});

async function connected() {
  const server = new FakeTerminalServer();
  server.items = [sampleTerminalInfo({ terminalId: TERMINAL })];
  const controller = new TerminalController({
    sessionKey: TERMINAL_SESSION_KEY,
    entryId: SAMPLE_IDS.entry,
    url: TERMINAL_SOCKET_URL,
    createSocket: server.factory,
  });
  controller.start();
  cleanups.push(() => {
    controller.stop();
  });
  await vi.waitFor(() => {
    expect(controller.store.getState().loaded).toBe(true);
  });
  return { server, controller };
}

function mount(controller: TerminalController, env: TerminalEnvironment) {
  const host = document.createElement('div');
  document.body.append(host);
  const runtime = new TerminalViewRuntime({
    host,
    env,
    controller,
    terminalId: TERMINAL,
    onInput: () => undefined,
  });
  cleanups.push(() => {
    runtime.dispose();
    host.remove();
  });
  return runtime;
}

describe('TerminalViewRuntime (WP-99b)', () => {
  it('opens the engine with ConPTY only when the session host runs Windows (WP-104)', async () => {
    const { server, controller } = await connected();
    const { factory, engines } = createFakeEngineFactory();
    mount(controller, fakeTerminalEnvironment(factory, server.factory));
    updateHost(clientStore, LOCAL_HOST_ID, () => ({ hostState: sampleHostState({ platform: 'linux' }) }));
    mount(controller, fakeTerminalEnvironment(factory, server.factory));
    expect(engines.map((engine) => engine.conpty)).toEqual([true, false]);
  });

  it('fits again after the host resized – one `resize` per burst, none for the same size', async () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {
          return undefined;
        }
        disconnect() {
          return undefined;
        }
      },
    );
    const { server, controller } = await connected();
    const engines = createFakeEngineFactory();
    mount(controller, fakeTerminalEnvironment(engines.factory, server.factory));
    await vi.waitFor(() => {
      expect(server.sentOfType('attach')).toEqual([
        { type: 'attach', terminalId: TERMINAL, cols: 100, rows: 30 },
      ]);
    });
    const engine = engines.engines[0];
    const resized = observers[0];
    if (engine === undefined || resized === undefined) throw new Error('no engine or observer');

    vi.useFakeTimers();
    engine.nextFit = { cols: 120, rows: 40 };
    resized();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS / 2);
    resized();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS - 1);
    expect(server.sentOfType('resize')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(server.sentOfType('resize')).toEqual([
      { type: 'resize', terminalId: TERMINAL, cols: 120, rows: 40 },
    ]);

    resized();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(server.sentOfType('resize')).toHaveLength(1);

    // Hidden (no size): nothing goes out.
    engine.nextFit = null;
    resized();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(server.sentOfType('resize')).toHaveLength(1);
  });

  it('waits for the mono font before it opens the engine (and focuses it then)', async () => {
    const { server, controller } = await connected();
    const engines = createFakeEngineFactory();
    let fontLoaded: () => void = () => undefined;
    const runtime = mount(
      controller,
      fakeTerminalEnvironment(engines.factory, server.factory, {
        fontReady: () => false,
        loadFont: async () =>
          new Promise<void>((resolve) => {
            fontLoaded = resolve;
          }),
      }),
    );
    runtime.focus();
    expect(engines.engines).toHaveLength(0);
    expect(server.sentOfType('attach')).toEqual([]);
    fontLoaded();
    await vi.waitFor(() => {
      expect(engines.engines).toHaveLength(1);
    });
    expect(engines.engines[0]?.focusCount).toBe(1);
    expect(server.sentOfType('attach')).toHaveLength(1);
  });

  it('Ctrl+C with a selection copies through the clipboard and clears the selection', async () => {
    const { server, controller } = await connected();
    const engines = createFakeEngineFactory();
    const copyText = vi.fn(async () => Promise.resolve(true));
    mount(controller, fakeTerminalEnvironment(engines.factory, server.factory, { copyText }));
    const engine = engines.engines[0];
    const textarea = engine?.textarea ?? null;
    if (engine === undefined || textarea === null) throw new Error('no engine');
    engine.selection = 'some output';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true }));
    expect(copyText).toHaveBeenCalledWith('some output');
    expect(engine.selection).toBe('');
    expect(engine.keys).toEqual([]);
    // Now without a selection: ^C reaches the shell.
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true }));
    expect(engine.keys).toEqual(['c']);
  });
});
