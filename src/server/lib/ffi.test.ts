import { describe, expect, it } from 'vitest';
import { LIBC_CANDIDATES, loadFfi, openLibc, openLibrary } from './ffi';

const x64 = process.arch === 'x64';

describe('node:ffi bindings per platform (ADR-229, WP-103)', () => {
  it('libc candidates: absolute Debian/Ubuntu paths first, then the soname', () => {
    expect(LIBC_CANDIDATES.at(-1)).toBe('libc.so.6');
    expect(LIBC_CANDIDATES.slice(0, -1).every((file) => file.startsWith('/'))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('off Windows a .dll is never handed to dlopen', () => {
    expect(
      openLibrary('kernel32.dll', { GetCurrentProcessId: { return: 'uint32', arguments: [] } }),
    ).toBeNull();
    expect(
      openLibrary('KERNEL32.DLL', { GetCurrentProcessId: { return: 'uint32', arguments: [] } }),
    ).toBeNull();
  });

  it.runIf(process.platform !== 'linux')('openLibc exists only on Linux', () => {
    expect(openLibc({ getpid: { return: 'int32', arguments: [] } })).toBeNull();
  });

  it.runIf(process.platform === 'win32' && x64)('Windows x64: kernel32 answers in this process', () => {
    const kernel32 = openLibrary('kernel32.dll', {
      GetCurrentProcessId: { return: 'uint32', arguments: [] },
    });
    expect(kernel32?.GetCurrentProcessId()).toBe(process.pid);
  });

  it.runIf(process.platform === 'linux' && x64)(
    'Linux x64: node:ffi loads and libc answers in this process',
    () => {
      expect(loadFfi()).not.toBeNull();
      const libc = openLibc({
        getpid: { return: 'int32', arguments: [] },
        getppid: { return: 'int32', arguments: [] },
      });
      expect(libc?.getpid()).toBe(process.pid);
      expect(libc?.getppid()).toBe(process.ppid);
      // A missing symbol makes the whole binding unavailable.
      expect(openLibc({ parallax_no_such_symbol: { return: 'int32', arguments: [] } })).toBeNull();
    },
  );
});
