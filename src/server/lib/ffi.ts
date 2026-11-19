/**
 * Node's built-in `node:ffi` (experimental; since Node 26.1 behind --experimental-ffi, on by default since 26.9) – the one place that
 * loads it (ADR-229). Windows APIs are called in this process instead of through a started
 * PowerShell: a Node server that starts PowerShell for system queries looks like malware to
 * behaviour-based security software.
 *
 * - Null without `node:ffi` (an older Node than the minimum 26.9, `--no-experimental-ffi`, the
 *   permission model without `--allow-ffi`) or off Windows x64 – callers report "unknown" or "not
 *   available" (ADR-231: no PowerShell fallback).
 * - Its one ExperimentalWarning at load is swallowed (only that warning).
 * - Only the few calls used are typed here; every function is checked at runtime.
 */

export type FfiFunction = (...args: unknown[]) => unknown;

export interface FfiSignature {
  return: string;
  arguments: string[];
}

export interface FfiModule {
  dlopen(
    path: string,
    definitions: Record<string, FfiSignature>,
  ): { lib: { close(): void }; functions: Record<string, FfiFunction | undefined> };
  getRawPointer(buffer: Buffer): bigint;
  toBuffer(pointer: bigint, length: number): Buffer;
  exportBuffer(source: Buffer, pointer: bigint, length: number): void;
}

function isFfiModule(value: unknown): value is FfiModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dlopen' in value &&
    typeof value.dlopen === 'function' &&
    'getRawPointer' in value &&
    typeof value.getRawPointer === 'function' &&
    'toBuffer' in value &&
    typeof value.toBuffer === 'function' &&
    'exportBuffer' in value &&
    typeof value.exportBuffer === 'function'
  );
}

function warningType(rest: readonly unknown[]): unknown {
  const first = rest[0];
  if (typeof first === 'string') return first;
  return typeof first === 'object' && first !== null && 'type' in first ? first.type : undefined;
}

let cached: FfiModule | null | undefined;

/** `node:ffi` on Windows x64, else null (cached for the process). */
export function loadFfi(): FfiModule | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== 'win32' || process.arch !== 'x64') return cached;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- put back unchanged below, called with `process`
  const original = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...rest: unknown[]): void => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (warningType(rest) === 'ExperimentalWarning' && /\bFFI\b/u.test(text)) return;
    Reflect.apply(original, process, [warning, ...rest]);
  };
  try {
    const loaded: unknown = process.getBuiltinModule('node:ffi');
    cached = isFfiModule(loaded) ? loaded : null;
  } catch {
    cached = null;
  } finally {
    process.emitWarning = original;
  }
  return cached;
}

/**
 * The functions of a system library, or null if `node:ffi`, the library or one of the symbols is
 * missing. The library stays open for the process (system DLLs, loaded anyway).
 */
export function openLibrary<K extends string>(
  path: string,
  definitions: Record<K, FfiSignature>,
): Record<K, FfiFunction> | null {
  const ffi = loadFfi();
  if (ffi === null) return null;
  let functions: Record<string, FfiFunction | undefined>;
  try {
    functions = ffi.dlopen(path, definitions).functions;
  } catch {
    return null;
  }
  const out: Partial<Record<K, FfiFunction>> = {};
  for (const name of Object.keys(definitions) as K[]) {
    const fn = functions[name];
    if (fn === undefined) return null;
    out[name] = fn;
  }
  return out as Record<K, FfiFunction>;
}

/** A pointer result as bigint (`node:ffi` returns pointers as bigint; null/undefined → 0n). */
export function pointerValue(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return 0n;
}
