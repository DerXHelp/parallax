import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA_VERSION, settingsFileSchema } from '@shared/model';
import { sampleSettings } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import { SETTINGS_FILE, openSettingsStore, settingsForHost } from './settings';

const withShell = (defaultShell: 'cmd' | 'powershell' | 'login' | 'bash') =>
  sampleSettings({ console: { ...sampleSettings().console, defaultShell } });

describe('settingsForHost (WP-103)', () => {
  it('Windows: every Windows shell stays (same object); a POSIX shell becomes cmd', () => {
    for (const shell of ['cmd', 'powershell'] as const) {
      const settings = withShell(shell);
      expect(settingsForHost(settings, 'win32')).toBe(settings);
    }
    expect(settingsForHost(withShell('bash'), 'win32')).toEqual(withShell('cmd'));
  });

  it('Linux: a shell the host does not offer becomes login; a POSIX shell stays', () => {
    expect(settingsForHost(withShell('cmd'), 'linux')).toEqual(withShell('login'));
    expect(settingsForHost(withShell('powershell'), 'linux')).toEqual(withShell('login'));
    const bash = withShell('bash');
    expect(settingsForHost(bash, 'linux')).toBe(bash);
  });
});

describe('openSettingsStore: the host view on load and update (WP-103)', () => {
  async function stored(home: string) {
    return settingsFileSchema.parse(JSON.parse(await readFile(path.join(home, SETTINGS_FILE), 'utf8')))
      .settings.console.defaultShell;
  }

  it('Linux: a stored cmd reads as login; the next update writes login', async () => {
    const home = await makeTempHome('settings-host-');
    const file = { schemaVersion: SETTINGS_SCHEMA_VERSION, settings: withShell('cmd') };
    await writeFile(path.join(home, SETTINGS_FILE), `${JSON.stringify(file)}\n`, 'utf8');
    const store = await openSettingsStore({ home, debounceMs: 5, platform: 'linux' });
    expect(store.get().console.defaultShell).toBe('login');
    expect(store.get()).toBe(store.get());
    expect(await stored(home)).toBe('cmd');
    expect(store.update({ language: 'de' })).toMatchObject({
      language: 'de',
      console: { defaultShell: 'login' },
    });
    // A patch with a Windows shell cannot store it on Linux either.
    const patched = store.update({ console: { ...store.get().console, defaultShell: 'powershell' } });
    expect(patched.console.defaultShell).toBe('login');
    expect(
      store.update({ console: { ...store.get().console, defaultShell: 'bash' } }).console.defaultShell,
    ).toBe('bash');
    await store.close();
    expect(await stored(home)).toBe('bash');
  });

  it('Windows: the default cmd stays, also in the file', async () => {
    const home = await makeTempHome('settings-host-');
    const store = await openSettingsStore({ home, debounceMs: 5, platform: 'win32' });
    expect(store.get().console.defaultShell).toBe('cmd');
    store.update({ language: 'de' });
    await store.close();
    expect(await stored(home)).toBe('cmd');
  });
});
