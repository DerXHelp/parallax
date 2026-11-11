import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileHead } from './fileRead';
import { PE_HEADER_BYTES, PE_SUBSYSTEM_WINDOWS_CUI, PE_SUBSYSTEM_WINDOWS_GUI, peSubsystem } from './pe';

const PE_OFFSET = 0x80;

/** A minimal PE header: MZ, e_lfanew, PE\0\0, COFF (SizeOfOptionalHeader), optional header magic + Subsystem. */
function peImage(
  options: {
    subsystem?: number;
    magic?: number;
    optionalSize?: number;
    signature?: string;
    lfanew?: number;
  } = {},
): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(options.lfanew ?? PE_OFFSET, 0x3c);
  bytes.write(options.signature ?? 'PE\0\0', PE_OFFSET, 'latin1');
  bytes.writeUInt16LE(options.optionalSize ?? 240, PE_OFFSET + 4 + 16);
  const optional = PE_OFFSET + 24;
  bytes.writeUInt16LE(options.magic ?? 0x20b, optional);
  bytes.writeUInt16LE(options.subsystem ?? PE_SUBSYSTEM_WINDOWS_GUI, optional + 68);
  return bytes;
}

describe('peSubsystem (ADR-144)', () => {
  it('reads the Subsystem of PE32+ and PE32 images', () => {
    expect(peSubsystem(peImage())).toBe(PE_SUBSYSTEM_WINDOWS_GUI);
    expect(peSubsystem(peImage({ subsystem: PE_SUBSYSTEM_WINDOWS_CUI }))).toBe(PE_SUBSYSTEM_WINDOWS_CUI);
    expect(peSubsystem(peImage({ magic: 0x10b }))).toBe(PE_SUBSYSTEM_WINDOWS_GUI);
  });

  it.each([
    ['no MZ', Buffer.from('#!/bin/sh\n'.padEnd(512, ' '))],
    ['too short', peImage().subarray(0, 0x40)],
    ['cut before the Subsystem field', peImage().subarray(0, PE_OFFSET + 24 + 60)],
    ['wrong PE signature', peImage({ signature: 'NE\0\0' })],
    ['unknown optional header magic', peImage({ magic: 0x107 })],
    ['optional header too small', peImage({ optionalSize: 60 })],
    ['e_lfanew far outside the bytes', peImage({ lfanew: 0xfffffff0 })],
    ['empty', Buffer.alloc(0)],
  ])('%s → null', (_name, bytes) => {
    expect(peSubsystem(bytes)).toBeNull();
  });

  it.runIf(process.platform === 'win32')(
    'real Windows images: explorer.exe is GUI, cmd.exe is console (read only)',
    async () => {
      const root = process.env.SystemRoot ?? 'C:\\Windows';
      const explorer = path.win32.join(root, 'explorer.exe');
      const cmd = path.win32.join(root, 'System32', 'cmd.exe');
      if (!existsSync(explorer) || !existsSync(cmd)) return;
      expect(peSubsystem(await readFileHead(explorer, PE_HEADER_BYTES))).toBe(PE_SUBSYSTEM_WINDOWS_GUI);
      expect(peSubsystem(await readFileHead(cmd, PE_HEADER_BYTES))).toBe(PE_SUBSYSTEM_WINDOWS_CUI);
    },
  );
});
