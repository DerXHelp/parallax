import { describe, expect, it } from 'vitest';
import {
  loginMethodsPresent,
  probeOutputStyle,
  probeStyleFor,
  type OutputStyleProbeHandle,
  type ProbeFs,
} from './outputStyle';

const CWD = 'C:\\Temp\\cli-check-1';
const FILE = 'C:\\Temp\\cli-check-1\\.claude\\settings.local.json';

type MemoryFs = ProbeFs & { files: Map<string, string> };

function memoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: (file) => Promise.resolve(files.get(file) ?? null),
    write: (file, text) => {
      files.set(file, text);
      return Promise.resolve();
    },
    remove: (file) => {
      files.delete(file);
      return Promise.resolve();
    },
    removeEmptyDir: () => Promise.resolve(),
    ensureDir: () => Promise.resolve(),
  };
}

function handle(fs: MemoryFs, o: { effective?: boolean; write?: boolean } = {}): OutputStyleProbeHandle {
  let current = 'default';
  return {
    initializationResult: () =>
      Promise.resolve({
        output_style: 'default',
        available_output_styles: ['default', 'Concise', 'Explanatory'],
      }),
    updateSettings: (_source, settings) => {
      current = String(settings.outputStyle);
      if (o.write !== false) fs.files.set(FILE, JSON.stringify({ outputStyle: current }));
      return Promise.resolve();
    },
    getSettings: () =>
      Promise.resolve({ effective: { outputStyle: o.effective === false ? 'default' : current } }),
  };
}

const quick = { cwd: CWD, controlMs: 1000, waitMs: 0, pollMs: 1, sleep: () => Promise.resolve() };

describe('cli-check output style step (WP-70)', () => {
  it('round trip: Explanatory written and effective, the scratch folder restored', async () => {
    const fs = memoryFs();
    const result = await probeOutputStyle(handle(fs), { ...quick, fs });
    expect(result).toEqual({
      available: true,
      detail: null,
      style: 'Explanatory',
      styles: 3,
      written: true,
      effective: true,
      restored: true,
    });
    expect(fs.files.has(FILE)).toBe(false);
  });

  it('an earlier settings.local.json is written back; failures are named', async () => {
    const fs = memoryFs({ [FILE]: '{"outputStyle":"Concise"}' });
    const notEffective = await probeOutputStyle(handle(fs, { effective: false }), { ...quick, fs });
    expect(notEffective).toMatchObject({ available: false, written: true, effective: false, restored: true });
    expect(fs.files.get(FILE)).toBe('{"outputStyle":"Concise"}');
    const empty = memoryFs();
    const notWritten = await probeOutputStyle(handle(empty, { write: false }), { ...quick, fs: empty });
    expect(notWritten.detail).toContain('settings.local.json');
    const missing = await probeOutputStyle({}, { ...quick, fs: memoryFs() });
    expect(missing).toMatchObject({ available: false, detail: 'Query.updateSettings is missing (SDK)' });
  });

  it('probeStyleFor prefers Explanatory, never the current style; login methods only checked', () => {
    expect(probeStyleFor('default', ['default', 'Concise', 'Explanatory'])).toBe('Explanatory');
    expect(probeStyleFor('Explanatory', ['Explanatory', 'Concise'])).toBe('Concise');
    expect(probeStyleFor('default', ['default'])).toBeNull();
    const never = (): Promise<unknown> => Promise.reject(new Error('never called'));
    expect(
      loginMethodsPresent({
        claudeAuthenticate: never,
        claudeOAuthCallback: never,
        claudeOAuthWaitForCompletion: never,
      }),
    ).toBe(true);
    expect(loginMethodsPresent({})).toBe(false);
  });
});
