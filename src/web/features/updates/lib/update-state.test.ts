import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@shared/model';
import { SAMPLE_UPDATE_STATES, sampleHostState, sampleTime } from '@shared/samples';
import {
  hasUpdateBanner,
  isPackaged,
  isUpdateBusy,
  isVersionBack,
  updateNotice,
  whatsNewSince,
} from './update-state';

describe('updateNotice (sidebar hint)', () => {
  it('shows for available and ready, with the offered version', () => {
    expect(updateNotice(SAMPLE_UPDATE_STATES.available)).toEqual({ kind: 'available', version: '1.0.1' });
    expect(updateNotice(SAMPLE_UPDATE_STATES.ready)).toEqual({ kind: 'ready', version: '1.0.1' });
    expect(updateNotice(SAMPLE_UPDATE_STATES.readyFromFile)).toEqual({
      kind: 'ready',
      version: '1.0.0-rc.4',
    });
  });

  it.each([
    'unsupported',
    'idle',
    'downloading',
    'restarting',
    'justUpdated',
    'failedUpdate',
    'checkFailed',
    'previous',
  ] as const)('stays hidden for %s', (name) => {
    expect(updateNotice(SAMPLE_UPDATE_STATES[name])).toBeNull();
  });

  it('stays hidden for a dismissed version, shows again for a newer one', () => {
    expect(updateNotice({ ...SAMPLE_UPDATE_STATES.available, dismissedVersion: '1.0.1' })).toBeNull();
    expect(updateNotice({ ...SAMPLE_UPDATE_STATES.ready, dismissedVersion: '1.0.1' })).toBeNull();
    expect(updateNotice({ ...SAMPLE_UPDATE_STATES.available, dismissedVersion: '1.0.0' })).not.toBeNull();
  });
});

describe('banner, direction and "What\'s new"', () => {
  it('shows a banner only after a version change or a failed switch', () => {
    expect(hasUpdateBanner(SAMPLE_UPDATE_STATES.justUpdated)).toBe(true);
    expect(hasUpdateBanner(SAMPLE_UPDATE_STATES.failedUpdate)).toBe(true);
    expect(hasUpdateBanner(SAMPLE_UPDATE_STATES.available)).toBe(false);
    expect(hasUpdateBanner(SAMPLE_UPDATE_STATES.checkFailed)).toBe(false);
  });

  it('a step back is older than before (pre-releases ordered by compareVersions)', () => {
    const at = sampleTime();
    expect(isVersionBack({ from: '1.0.0-rc.4', to: '1.0.0', at })).toBe(false);
    expect(isVersionBack({ from: '1.0.1', to: '1.0.0', at })).toBe(true);
    expect(isVersionBack({ from: '1.0.0', to: '1.0.0-rc.4', at })).toBe(true);
    expect(isVersionBack({ from: null, to: '1.0.0', at })).toBe(false);
  });

  it('"What\'s new" since the previous version, else the own section', () => {
    const at = sampleTime();
    expect(whatsNewSince({ from: '1.0.0-rc.4', to: '1.0.0', at })).toBe('1.0.0-rc.4');
    expect(whatsNewSince({ from: '1.0.1', to: '1.0.0', at })).toBeUndefined();
    expect(whatsNewSince({ from: null, to: '1.0.0', at })).toBeUndefined();
  });
});

describe('busy and packaged', () => {
  it('blocks the actions while a step runs', () => {
    const busy: UpdateStatus[] = ['checking', 'downloading', 'preparing', 'restarting'];
    const free: UpdateStatus[] = ['unsupported', 'idle', 'available', 'ready'];
    expect(busy.every(isUpdateBusy)).toBe(true);
    expect(free.some(isUpdateBusy)).toBe(false);
  });

  it('is an installation only with app.packaged and a supported status', () => {
    const app = { version: '1.0.0', buildId: '1.0.0+sample', packaged: true };
    expect(isPackaged(sampleHostState({ app, update: SAMPLE_UPDATE_STATES.idle }))).toBe(true);
    expect(isPackaged(sampleHostState({ app, update: SAMPLE_UPDATE_STATES.unsupported }))).toBe(false);
    expect(isPackaged(sampleHostState({ update: SAMPLE_UPDATE_STATES.idle }))).toBe(false);
    expect(isPackaged(sampleHostState({ app: null, update: SAMPLE_UPDATE_STATES.idle }))).toBe(false);
  });
});
