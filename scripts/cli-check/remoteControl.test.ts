/**
 * WP-64 §1.5: the Remote Control step of `pnpm cli-check` with a fake Query handle – never live.
 * Shapes from the spike of 12.11.2026 (`enableRemoteControl` answer, `system/bridge_state`).
 */
import { describe, expect, it } from 'vitest';
import { compareObservation, remoteControlFinding } from './compare';
import { observationFrom } from './observation';
import { evaluate, formatReport } from './report';
import {
  BridgeWatch,
  REMOTE_CONTROL_PROBE_NAME,
  bridgeStateOf,
  probeRemoteControl,
  type RemoteControlProbeHandle,
} from './remoteControl';
import { sampleObservation, sampleProfile, sampleRecord } from './samples';

const ANSWER = {
  session_url: 'https://claude.ai/code/session_01QKkfSZajXxCTUVAWr5SbHm',
  connect_url: 'https://claude.ai/code?environment=',
  environment_id: '',
  bridge_epoch: 1,
  bridge_session_id: 'cse_01QKkfSZajXxCTUVAWr5SbHm',
};

function bridge(state: string, fields: Record<string, unknown> = {}): unknown {
  return { type: 'system', subtype: 'bridge_state', state, ...fields, uuid: 'u', session_id: 's' };
}

interface FakeHandle extends RemoteControlProbeHandle {
  calls: unknown[][];
}

/** `enable(true)` answers `answer` and emits `states` (after the answer); `enable(false)` per `disable`. */
function fakeHandle(
  watch: BridgeWatch,
  o: {
    answer?: () => Promise<unknown>;
    states?: unknown[];
    disable?: () => Promise<unknown>;
  } = {},
): FakeHandle {
  const calls: unknown[][] = [];
  return {
    calls,
    close: () => undefined,
    enableRemoteControl: (...args: [boolean, string?]) => {
      calls.push(args);
      if (!args[0]) return o.disable?.() ?? Promise.resolve(null);
      const answer = (o.answer ?? (() => Promise.resolve(ANSWER)))();
      void answer.then(
        () => {
          setTimeout(() => {
            for (const state of o.states ?? []) watch.push(state);
          }, 1);
        },
        () => undefined,
      );
      return answer;
    },
  };
}

const OPTIONS = { controlMs: 1_000, connectMs: 200 };

describe('bridgeStateOf (WP-64)', () => {
  it('reads bridge_state with the normalizer parser; anything else → null', () => {
    expect(bridgeStateOf(bridge('connected'))).toEqual({ state: 'connected', detail: null, failureKind: null });
    expect(bridgeStateOf(bridge('failed', { detail: 'gone', failure_kind: 'terminal' }))).toEqual({
      state: 'failed',
      detail: 'gone',
      failureKind: 'terminal',
    });
    // An unknown state of a newer CLI keeps its name for the report.
    expect(bridgeStateOf(bridge('hibernating'))?.state).toBe('hibernating');
    expect(bridgeStateOf({ type: 'system', subtype: 'init' })).toBeNull();
    expect(bridgeStateOf({ type: 'system', subtype: 'bridge_state' })).toBeNull();
    expect(bridgeStateOf('text')).toBeNull();
  });
});

describe('probeRemoteControl (WP-64 §1.5, fake handle)', () => {
  it('green: enable with the name, schema ok, connected in time, switched off again', async () => {
    const watch = new BridgeWatch();
    const handle = fakeHandle(watch, { states: [bridge('ready'), bridge('connected', { bridge_epoch: 1 })] });
    let clock = 1_000;
    const result = await probeRemoteControl(handle, watch, {
      ...OPTIONS,
      now: () => (clock += 210),
    });
    expect(result).toEqual({ available: true, detail: null, connectedMs: 210, disabled: true });
    expect(handle.calls).toEqual([[true, REMOTE_CONTROL_PROBE_NAME], [false]]);
  });

  it('a connected that came before the wait started (but after the request) counts', async () => {
    const watch = new BridgeWatch();
    watch.push(bridge('connected'));
    const handle: FakeHandle = {
      calls: [],
      close: () => undefined,
      enableRemoteControl(enabled: boolean) {
        if (enabled) watch.push(bridge('connected'));
        return Promise.resolve(enabled ? ANSWER : null);
      },
    };
    expect((await probeRemoteControl(handle, watch, OPTIONS)).available).toBe(true);
    // A connected from BEFORE the request does not count.
    const stale = new BridgeWatch();
    stale.push(bridge('connected'));
    const quiet = fakeHandle(stale);
    expect((await probeRemoteControl(quiet, stale, OPTIONS)).detail).toBe('no bridge_state connected within 0.2 s');
  });

  it('SDK without the method → not available, nothing called', async () => {
    const watch = new BridgeWatch();
    expect(await probeRemoteControl({ close: () => undefined }, watch, OPTIONS)).toEqual({
      available: false,
      detail: 'Query.enableRemoteControl is missing (SDK)',
      connectedMs: null,
      disabled: true,
    });
  });

  it.each([
    [{}, 'the answer of enableRemoteControl does not match the expected schema (bridge_session_id …)'],
    [{ ...ANSWER, session_url: 'https://evil.example/code/x' }, 'the answer has no https://claude.ai session_url'],
    [{ bridge_session_id: 'cse_x' }, 'the answer has no https://claude.ai session_url'],
  ])('answer %j → not available, switched off anyway', async (answer, detail) => {
    const watch = new BridgeWatch();
    const handle = fakeHandle(watch, { answer: () => Promise.resolve(answer), states: [bridge('connected')] });
    expect(await probeRemoteControl(handle, watch, OPTIONS)).toMatchObject({ available: false, detail, disabled: true });
    expect(handle.calls.at(-1)).toEqual([false]);
  });

  it('terminal failure or policy_disabled ends the wait early; a transient failure keeps waiting', async () => {
    const watch = new BridgeWatch();
    const terminal = fakeHandle(watch, {
      states: [bridge('ready'), bridge('failed', { detail: 'session ended', failure_kind: 'terminal' })],
    });
    expect((await probeRemoteControl(terminal, watch, OPTIONS)).detail).toBe(
      'bridge_state failed (terminal): session ended',
    );
    const policy = new BridgeWatch();
    expect((await probeRemoteControl(fakeHandle(policy, { states: [bridge('policy_disabled')] }), policy, OPTIONS)).detail).toBe(
      'bridge_state policy_disabled',
    );
    const flaky = new BridgeWatch();
    const transient = fakeHandle(flaky, {
      states: [bridge('failed', { failure_kind: 'transient' }), bridge('connected', { recovered: true })],
    });
    expect((await probeRemoteControl(transient, flaky, OPTIONS)).available).toBe(true);
  });

  it('enable rejected (errorCode) → the code in the detail; switching off is still tried', async () => {
    const watch = new BridgeWatch();
    const error = Object.assign(new Error('Remote Control requires a claude.ai login'), {
      errorCode: 'remote_control_auth',
    });
    const handle = fakeHandle(watch, { answer: () => Promise.reject(error) });
    expect(await probeRemoteControl(handle, watch, OPTIONS)).toEqual({
      available: false,
      detail: 'enableRemoteControl(true) failed: REMOTE_CONTROL_AUTH',
      connectedMs: null,
      disabled: true,
    });
    expect(handle.calls).toEqual([[true, REMOTE_CONTROL_PROBE_NAME], [false]]);
    const unsupported = new BridgeWatch();
    const old = fakeHandle(unsupported, {
      answer: () => Promise.reject(new Error('Unsupported control request subtype: remote_control')),
    });
    expect((await probeRemoteControl(old, unsupported, OPTIONS)).detail).toBe(
      'enableRemoteControl(true) failed: REMOTE_CONTROL_UNAVAILABLE (cli)',
    );
  });

  it('switching off fails → disabled false (the report asks to remove the remote session), logged', async () => {
    const watch = new BridgeWatch();
    const lines: string[] = [];
    const handle = fakeHandle(watch, {
      states: [bridge('connected')],
      disable: () => Promise.reject(new Error('boom')),
    });
    const result = await probeRemoteControl(handle, watch, { ...OPTIONS, log: (line) => lines.push(line) });
    expect(result).toMatchObject({ available: true, disabled: false });
    expect(lines.some((line) => line.includes('switching Remote Control off failed'))).toBe(true);
  });

  it('an answer that never comes → timeout of the control request', async () => {
    const watch = new BridgeWatch();
    const handle = fakeHandle(watch, { answer: () => new Promise<unknown>(() => undefined) });
    expect((await probeRemoteControl(handle, watch, { controlMs: 30, connectMs: 30 })).detail).toBe(
      'enableRemoteControl(true) failed: REMOTE_CONTROL_FAILED (timeout)',
    );
  });
});

describe('profile, comparison and report (WP-64 §1.5)', () => {
  it('observation carries the result; absent = null', () => {
    const init = { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', claude_code_version: '2.1.322' };
    const raw = { init, initializationResult: null, supportedModels: null, contextUsage: null };
    expect(observationFrom(raw, '0.3.322').remoteControl).toBeNull();
    expect(observationFrom({ ...raw, remoteControl: false }, '0.3.322').remoteControl).toBe(false);
  });

  it('true ↔ false is a deviation; a first check or no check is a note', () => {
    expect(remoteControlFinding(true, true)).toBeNull();
    expect(remoteControlFinding(true, false)).toMatchObject({
      area: 'remoteControl',
      level: 'deviation',
      title: 'remote control (enableRemoteControl + bridge_state connected): available → not available',
    });
    expect(remoteControlFinding(false, true)?.level).toBe('deviation');
    expect(remoteControlFinding(null, true)).toMatchObject({
      level: 'note',
      title: 'remote control (enableRemoteControl + bridge_state connected): checked for the first time – available',
    });
    expect(remoteControlFinding(true, null)?.level).toBe('note');
    const findings = compareObservation(sampleProfile(), sampleObservation({ remoteControl: false }));
    expect(findings.map((finding) => [finding.area, finding.level])).toEqual([['remoteControl', 'deviation']]);
    expect(findings[0]?.hint).toContain('backend/remoteControl.ts');
  });

  it('the report names the result (and a remote session left behind); old run files parse', () => {
    const profile = sampleProfile();
    const record = sampleRecord();
    const green = formatReport({ record, profile, profilePath: 'p.json', evaluation: evaluate(record, profile), mode: 'live' });
    expect(green).toContain('- remote control: available (bridge connected after 420 ms)');
    const failed = sampleRecord({
      observation: sampleObservation({ remoteControl: false }),
      probe: {
        ...(sampleRecord().probe ?? { costUsd: 0, sessionIds: [], apiKeySource: 'none', resultSubtype: 'success', messageTypes: {}, contextDetail: null, durationMs: 0, overview: null }),
        remoteControl: { available: false, detail: 'bridge_state policy_disabled', connectedMs: null, disabled: false },
      },
    });
    const evaluation = evaluate(failed, profile);
    expect(evaluation.exitCode).toBe(1);
    const text = formatReport({ record: failed, profile, profilePath: 'p.json', evaluation, mode: 'live' });
    expect(text).toContain('- remote control: NOT available – bridge_state policy_disabled');
    expect(text).toContain('remove "Parallax cli-check" in the Claude app');
  });
});
