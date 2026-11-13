/**
 * WP-70 – output style per project and the engine side of the login, through the real manager with
 * the FakeBackend (speed 0) and the memory stores: readiness reads the styles
 * (`initializationResult`), `session.setOutputStyle` writes them through `updateSettings` (a dormant
 * entry starts without a turn), the next turn's init reports the style, gates and failures; the host
 * state carries `ProfileSummary.login`; after a login Remote Control connects again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { IDLE_PROFILE_LOGIN, type ProfileLogin } from '@shared/model';
import { FAKE_OUTPUT_STYLES } from '../backend/fakeBackend';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(h.errors).toEqual([]);
  }
});

async function setup(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const h = await createEngineHarness(options);
  harnesses.push(h);
  return h;
}

async function idleEntry(h: EngineHarness, prompt = 'Reply with exactly: OK'): Promise<EntryId> {
  const entryId = await h.create(prompt);
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
  return entryId;
}

describe('output style per project (WP-70)', () => {
  it('readiness reads the styles: summary.outputStyle and detail.availableOutputStyles', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    expect(h.summary(entryId).outputStyle).toBe('default');
    const patches = (h.publisher.ops.get(entryId) ?? []).flatMap((op) =>
      op.op === 'detail.patch' && op.patch.availableOutputStyles !== undefined ? [op.patch] : [],
    );
    expect(patches.at(-1)?.availableOutputStyles).toEqual([...FAKE_OUTPUT_STYLES]);
  });

  it('setOutputStyle writes localSettings, shows at once and the next init reports it', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.setOutputStyle', entryId, style: 'Explanatory' });
    expect(h.session(entryId).controls).toContainEqual({
      method: 'updateSettings',
      args: ['localSettings', { outputStyle: 'Explanatory' }],
    });
    expect(h.summary(entryId).outputStyle).toBe('Explanatory');
    expect(h.backend.outputStyles.get(h.summary(entryId).cwd)).toBe('Explanatory');
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:output-style' } });
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(h.summary(entryId).outputStyle).toBe('Explanatory');
    const texts = (h.publisher.ops.get(entryId) ?? []).flatMap((op) =>
      op.op === 'item.upsert' && op.item.kind === 'assistant_text' ? [op.item.text] : [],
    );
    expect(texts.at(-1)).toBe('Fake: output style Explanatory');
  });

  it('a dormant entry starts without a turn for it; unknown styles and failures are refused', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.close', entryId });
    await h.settle();
    expect(h.session(entryId).state).toBe('exited');
    await h.cmd({ name: 'session.setOutputStyle', entryId, style: 'Concise' });
    expect(h.sessions(entryId)).toHaveLength(2);
    expect(h.session(entryId).sent).toEqual([]);
    expect(h.summary(entryId).outputStyle).toBe('Concise');
    await h.settle();
    const unknown = await h.cmdError({ name: 'session.setOutputStyle', entryId, style: 'Pirate' });
    expect(unknown).toMatchObject({ code: 'VALIDATION_FAILED', params: { field: 'style' } });
  });

  it('updateSettings failing → CLAUDE_CONTROL_FAILED {method:updateSettings}; archived entries are refused', async () => {
    const h = await setup({ outputStyleError: true });
    const entryId = await idleEntry(h);
    const failed = await h.cmdError({ name: 'session.setOutputStyle', entryId, style: 'Learning' });
    expect(failed).toMatchObject({ code: 'CLAUDE_CONTROL_FAILED', params: { method: 'updateSettings' } });
    expect(h.summary(entryId).outputStyle).toBe('default');
    await h.cmd({ name: 'session.setArchived', entryId, archived: true });
    await h.settle();
    const archived = await h.cmdError({ name: 'session.setOutputStyle', entryId, style: 'Learning' });
    expect(archived.code).toBe('SESSION_ARCHIVED');
  });
});

describe('login state and Remote Control after a login (WP-70)', () => {
  it('the host state carries the login state of each profile', async () => {
    let login: ProfileLogin = { ...IDLE_PROFILE_LOGIN };
    const h = await setup({ loginState: () => login });
    h.manager.publishHostState();
    expect(h.publisher.hostStates.at(-1)?.profiles[0]?.login).toEqual(IDLE_PROFILE_LOGIN);
    login = { ...IDLE_PROFILE_LOGIN, state: 'done', subscriptionType: 'max', at: h.now().toISOString() };
    h.manager.publishHostState();
    expect(h.publisher.hostStates.at(-1)?.profiles[0]?.login).toMatchObject({ state: 'done', subscriptionType: 'max' });
  });

  it('a bridge that failed for the sign-in connects again after the login of its profile', async () => {
    const remoteControl: NonNullable<EngineHarnessOptions['remoteControl']> = { enable: 'auth' };
    const h = await setup({ remoteControl });
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.setRemoteControl', entryId, enabled: true });
    await h.settle();
    expect(h.summary(entryId).remoteControl).toMatchObject({ state: 'failed', error: { code: 'REMOTE_CONTROL_AUTH' } });
    remoteControl.enable = 'ok';
    h.manager.onProfileLoggedIn(h.summary(entryId).profileId);
    await h.waitFor(() => h.summary(entryId).remoteControl.state !== 'failed');
    expect(h.session(entryId).controls.filter((c) => c.method === 'setRemoteControl')).toHaveLength(2);
    // Another profile's login changes nothing.
    h.manager.onProfileLoggedIn('pf_00000000000000000000000000000099');
    await h.settle();
    expect(h.session(entryId).controls.filter((c) => c.method === 'setRemoteControl')).toHaveLength(2);
  });
});
