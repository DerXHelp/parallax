/**
 * Portable Executable header (Phase 3, ADR-144): `spawnGui` only starts programs whose optional
 * header names the Windows GUI subsystem – a console program (cmd-like tools, script hosts)
 * started visibly and detached would open a console window the user did not ask for.
 * Layout: `MZ` → `e_lfanew` (uint32 at 0x3C) → `PE\0\0` → COFF header (20 bytes) → optional header
 * (magic 0x10B PE32 / 0x20B PE32+, `Subsystem` at offset 68 in both).
 */

/** Bytes read for the check (the PE header normally starts within the first few hundred bytes). */
export const PE_HEADER_BYTES = 64 * 1024;
export const PE_SUBSYSTEM_WINDOWS_GUI = 2;
export const PE_SUBSYSTEM_WINDOWS_CUI = 3;

const PE_SIGNATURE = 0x00004550; // "PE\0\0" little endian
const COFF_HEADER_BYTES = 20;
const SUBSYSTEM_OFFSET = 68;
const OPTIONAL_MAGIC_PE32 = 0x10b;
const OPTIONAL_MAGIC_PE32_PLUS = 0x20b;

/** The `Subsystem` field of a PE image, or null if `bytes` do not start with a readable PE header. */
export function peSubsystem(bytes: Uint8Array): number | null {
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  const optional = peOffset + 4 + COFF_HEADER_BYTES;
  if (optional + SUBSYSTEM_OFFSET + 2 > bytes.length) return null;
  if (view.getUint32(peOffset, true) !== PE_SIGNATURE) return null;
  const optionalSize = view.getUint16(peOffset + 4 + 16, true);
  if (optionalSize < SUBSYSTEM_OFFSET + 2) return null;
  const magic = view.getUint16(optional, true);
  if (magic !== OPTIONAL_MAGIC_PE32 && magic !== OPTIONAL_MAGIC_PE32_PLUS) return null;
  return view.getUint16(optional + SUBSYSTEM_OFFSET, true);
}
