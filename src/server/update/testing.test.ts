import { describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { SAMPLE_IDS, sampleUpdateRelease } from '@shared/samples';
import { CommandError } from '../sync/ports';
import { UPDATE_COMMAND_NAMES } from './ports';
import { createFakeUpdateService } from './testing';

const ctx = { clientId: SAMPLE_IDS.client, cmdId: SAMPLE_IDS.cmdId };

describe('createFakeUpdateService', () => {
  it('records commands, answers like the contract and notifies on state changes', async () => {
    const update = createFakeUpdateService();
    expect(update.names).toEqual(UPDATE_COMMAND_NAMES);
    expect(update.app()).toMatchObject({ packaged: true });
    expect(update.state().status).toBe('idle');
    const listener = vi.fn();
    const off = update.onChange(listener);
    expect(await update.handle({ name: 'update.check' }, ctx)).toEqual({ available: null });
    update.setState({ status: 'available', available: sampleUpdateRelease() });
    expect(listener).toHaveBeenCalledOnce();
    expect(await update.handle({ name: 'update.check' }, ctx)).toEqual({
      available: sampleUpdateRelease().version,
    });
    expect(await update.handle({ name: 'update.dismiss', what: 'available' }, ctx)).toEqual({});
    expect(update.state().dismissedVersion).toBe(sampleUpdateRelease().version);
    expect(update.commands.map((cmd) => cmd.name)).toEqual([
      'update.check',
      'update.check',
      'update.dismiss',
    ]);
    off();
    update.setState({ status: 'idle' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('fails a queued command once, then answers again', async () => {
    const update = createFakeUpdateService();
    update.failNext('update.apply', makeError('UPDATE_RESTART_FAILED', { version: '1.0.1', reason: 'lock' }));
    const cmd = { name: 'update.apply', version: '1.0.1', acceptDataLoss: false } as const;
    await expect(update.handle(cmd, ctx)).rejects.toBeInstanceOf(CommandError);
    expect(await update.handle(cmd, ctx)).toEqual({});
  });

  it('is unsupported when not packaged and tracks lifecycle calls', async () => {
    const update = createFakeUpdateService({ app: { packaged: false } });
    expect(update.state().status).toBe('unsupported');
    update.start();
    update.setOrchestratorPid(77);
    update.acceptPackage('x.zip');
    expect([update.started(), update.orchestratorPid(), update.accepted]).toEqual([true, 77, ['x.zip']]);
    update.onChange(() => undefined);
    await update.close();
    expect([update.closed(), update.listenerCount()]).toEqual([true, 0]);
  });
});
