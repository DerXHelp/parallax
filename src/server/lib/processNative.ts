/**
 * The process list without starting a process (ADR-229): `CreateToolhelp32Snapshot` +
 * `Process32FirstW/NextW` (PID, parent, image name) and `OpenProcess(QUERY_LIMITED_INFORMATION)` +
 * `GetProcessTimes` (creation time), kernel32 through `node:ffi` (lib/ffi.ts). About 10–30 ms for
 * the whole machine instead of 1–3 s for PowerShell + CIM – and nothing a security product reads
 * as process discovery by a script.
 *
 * Processes of other users or protected ones cannot be opened: their start time is null (the caller
 * decides; lib/process.ts leaves them out or answers `unknown` for a PID it asked for).
 */
import { openLibrary, pointerValue, type FfiFunction } from './ffi';

/** One row of the Toolhelp snapshot. */
export interface NativeProcessEntry {
  pid: number;
  parentPid: number;
  /** Image name, e.g. `claude.exe`. */
  name: string;
}

/** Seam of lib/process.ts (tests inject a fake). Never throws. */
export interface NativeProcessApi {
  /** Every process of the machine; null = the snapshot failed. */
  entries(): NativeProcessEntry[] | null;
  /** Creation time; null = not readable (gone, no rights). */
  startedAt(pid: number): Date | null;
}

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** `PROCESSENTRY32W` on x64: dwSize 0, th32ProcessID 8, th32ParentProcessID 32, szExeFile 44 (260 WCHAR). */
const ENTRY_BYTES = 568;
const PID_OFFSET = 8;
const PARENT_OFFSET = 32;
const NAME_OFFSET = 44;
const NAME_BYTES = 520;
/** INVALID_HANDLE_VALUE (-1) as an unsigned 64-bit pointer. */
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn;
/** 100 ns intervals between 1601-01-01 and 1970-01-01. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

function imageName(entry: Buffer): string {
  const raw = entry.subarray(NAME_OFFSET, NAME_OFFSET + NAME_BYTES);
  let end = 0;
  while (end + 1 < raw.length && (raw[end] !== 0 || raw[end + 1] !== 0)) end += 2;
  return raw.subarray(0, end).toString('utf16le');
}

function isValidHandle(handle: bigint): boolean {
  return handle !== 0n && handle !== INVALID_HANDLE && handle !== -1n;
}

/** kernel32 through `node:ffi`; null off Windows x64 or without `node:ffi`. */
export function loadNativeProcessApi(): NativeProcessApi | null {
  const k = openLibrary('kernel32.dll', {
    CreateToolhelp32Snapshot: { return: 'pointer', arguments: ['uint32', 'uint32'] },
    Process32FirstW: { return: 'int32', arguments: ['pointer', 'buffer'] },
    Process32NextW: { return: 'int32', arguments: ['pointer', 'buffer'] },
    OpenProcess: { return: 'pointer', arguments: ['uint32', 'int32', 'uint32'] },
    GetProcessTimes: { return: 'int32', arguments: ['pointer', 'buffer', 'buffer', 'buffer', 'buffer'] },
    CloseHandle: { return: 'int32', arguments: ['pointer'] },
  });
  if (k === null) return null;
  const close = (handle: bigint): void => {
    try {
      k.CloseHandle(handle);
    } catch {
      // nothing left to do
    }
  };
  const call = (fn: FfiFunction, ...args: unknown[]): unknown => fn(...args);

  return {
    entries() {
      let snapshot = 0n;
      try {
        snapshot = pointerValue(call(k.CreateToolhelp32Snapshot, TH32CS_SNAPPROCESS, 0));
        if (!isValidHandle(snapshot)) return null;
        const entry = Buffer.alloc(ENTRY_BYTES);
        const out: NativeProcessEntry[] = [];
        entry.writeUInt32LE(ENTRY_BYTES, 0);
        for (
          let ok = call(k.Process32FirstW, snapshot, entry);
          ok !== 0;
          ok = call(k.Process32NextW, snapshot, entry)
        ) {
          if (typeof ok !== 'number') return null;
          out.push({
            pid: entry.readUInt32LE(PID_OFFSET),
            parentPid: entry.readUInt32LE(PARENT_OFFSET),
            name: imageName(entry),
          });
          entry.fill(0);
          entry.writeUInt32LE(ENTRY_BYTES, 0);
        }
        return out;
      } catch {
        return null;
      } finally {
        if (isValidHandle(snapshot)) close(snapshot);
      }
    },
    startedAt(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) return null;
      let handle = 0n;
      try {
        handle = pointerValue(call(k.OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
        if (!isValidHandle(handle)) return null;
        const created = Buffer.alloc(8);
        const unused = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)];
        if (call(k.GetProcessTimes, handle, created, ...unused) === 0) return null;
        const ticks = created.readBigUInt64LE(0);
        if (ticks <= FILETIME_UNIX_EPOCH) return null;
        return new Date(Number((ticks - FILETIME_UNIX_EPOCH) / 10_000n));
      } catch {
        return null;
      } finally {
        if (isValidHandle(handle)) close(handle);
      }
    },
  };
}
